import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth";
import type { Config } from "../config";
import { hashPassword } from "../crypto";
import type { Sql } from "../db";
import { inviteHash, type EmailService } from "../emailService";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../errors";
import type { Hub } from "../realtime";

const email = z.string().trim().toLowerCase().email().max(254);

/** Password reset, email verification and accepting invitations. */
export function emailRoutes(app: FastifyInstance, sql: Sql, config: Config, hub: Hub, mail: EmailService) {
  const auth = requireAuth(sql, config);
  const limited = { config: { rateLimit: { max: config.authRateLimit, timeWindow: "1 minute" } } };

  /* ---------- password reset (signed out) ---------- */

  /** Always answers the same way, so it cannot be used to find out which emails have accounts. */
  app.post("/auth/password/forgot", limited, async (req) => {
    const body = z.object({ email }).parse(req.body);
    if (!mail.enabled) return { ok: true, emailEnabled: false };
    const [user] = await sql`select 1 from users where email = ${body.email}`;
    if (user) await mail.issueCode(body.email, "reset");
    return { ok: true, emailEnabled: true };
  });

  app.post("/auth/password/reset", limited, async (req) => {
    const body = z.object({ email, code: z.string().trim().min(6).max(12), newPassword: z.string().min(10, "Password must have at least 10 characters").max(256) }).parse(req.body);
    if (!(await mail.consumeCode(body.email, "reset", body.code))) throw badRequest("The code is wrong or expired. Ask for a new one.", "invalid_code");
    const [user] = await sql<{ id: string }[]>`
      update users set password_hash = ${await hashPassword(body.newPassword)}, email_verified_at = coalesce(email_verified_at, now())
      where email = ${body.email} returning id`;
    if (!user) throw badRequest("The code is wrong or expired. Ask for a new one.", "invalid_code");
    // A reset proves control of the inbox, not of the old sessions: sign out everywhere.
    const revoked = await sql<{ id: string }[]>`delete from sessions where user_id = ${user.id} returning id`;
    hub.closeSessions(revoked.map((r) => r.id));
    return { ok: true };
  });

  /* ---------- email verification ---------- */

  app.post("/me/email/send-code", { preHandler: auth, ...limited }, async (req) => {
    if (req.user!.emailVerified) throw conflict("Your email is already verified", "already_verified");
    const result = await mail.issueCode(req.user!.email, "verify");
    if (result === "disabled") throw badRequest("This server cannot send email. Ask the administrator to configure SMTP.", "email_disabled");
    if (result === "cooldown") throw new HttpError(429, "cooldown", "A code was sent less than a minute ago. Check your inbox (and spam folder).");
    return { ok: true };
  });

  app.post("/me/email/verify", { preHandler: auth, ...limited }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(12) }).parse(req.body);
    if (req.user!.emailVerified) return { ok: true, joined: [] };
    if (!(await mail.consumeCode(req.user!.email, "verify", code))) throw badRequest("The code is wrong or expired. Ask for a new one.", "invalid_code");
    await sql`update users set email_verified_at = now() where id = ${req.user!.id}`;
    // A verified address can now collect its pending invitations.
    return { ok: true, joined: await mail.acceptPendingInvites(req.user!) };
  });

  /* ---------- invitations ---------- */

  /** Accepts an invitation by code. The invitation must be addressed to the signed-in user's email. */
  app.post("/invites/accept", { preHandler: auth, ...limited }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(8).max(40) }).parse(req.body);
    const [inv] = await sql<{ id: string; workspace_id: string; role: string; email: string; accepted_at: Date | null; expired: boolean }[]>`
      select id, workspace_id, role, email, accepted_at, expires_at <= now() as expired from invites where code_hash = ${inviteHash(code)}`;
    if (!inv || inv.accepted_at || inv.expired) throw notFound("This invite code is wrong, expired or already used. Ask for a new invitation.");
    if (inv.email !== req.user!.email) {
      throw forbidden(`This invitation was sent to another email address. Sign in with that address to accept it.`, "invite_email_mismatch");
    }
    return { joined: [await mail.accept(req.user!, inv)] };
  });
}
