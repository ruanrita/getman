import type { FastifyInstance } from "fastify";
import { Secret, TOTP } from "otpauth";
import { z } from "zod";
import { createSession, publicUser, requireAuth } from "../auth";
import type { Config } from "../config";
import {
  decrypt,
  dummyPasswordHash,
  encrypt,
  hashPassword,
  newRecoveryCodes,
  newToken,
  normalizeRecoveryCode,
  sha256,
  verifyPassword,
} from "../crypto";
import type { Sql } from "../db";
import { badRequest, conflict, notFound, unauthorized } from "../errors";
import type { Hub } from "../realtime";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, "Password must have at least 10 characters").max(256);
const otpCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

const MFA_CHALLENGE_MINUTES = 5;
const MFA_MAX_ATTEMPTS = 5;

function totpFor(secretBase32: string, label: string) {
  return new TOTP({ issuer: "Getman", label, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secretBase32) });
}

export function authRoutes(app: FastifyInstance, sql: Sql, config: Config, hub: Hub) {
  const auth = requireAuth(sql, config);
  const limited = { config: { rateLimit: { max: config.authRateLimit, timeWindow: "1 minute" } } };

  /** Checks a TOTP code (±1 step) or an unused recovery code, consuming the latter. */
  async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
    const [u] = await sql<{ email: string; totp_secret: string | null }[]>`select email, totp_secret from users where id = ${userId}`;
    if (!u?.totp_secret) return false;
    if (/^\d{6}$/.test(code.trim())) {
      return totpFor(decrypt(config.encryptionKey, u.totp_secret), u.email).validate({ token: code.trim(), window: 1 }) !== null;
    }
    const [used] = await sql`
      update recovery_codes set used_at = now()
      where user_id = ${userId} and used_at is null and code_hash = ${sha256(normalizeRecoveryCode(code))}
      returning id`;
    return Boolean(used);
  }

  async function storeRecoveryCodes(userId: string): Promise<string[]> {
    const codes = newRecoveryCodes();
    await sql.begin(async (tx) => {
      await tx`delete from recovery_codes where user_id = ${userId}`;
      for (const c of codes) await tx`insert into recovery_codes (user_id, code_hash) values (${userId}, ${sha256(normalizeRecoveryCode(c))})`;
    });
    return codes;
  }

  /* ---------- sign up / sign in ---------- */

  app.post("/auth/register", limited, async (req) => {
    const body = z.object({ email, password, name: z.string().trim().min(1).max(100) }).parse(req.body);
    const [existing] = await sql`select 1 from users where email = ${body.email}`;
    if (existing) throw conflict("An account with this email already exists", "email_taken");
    const [user] = await sql<{ id: string; email: string; name: string; totp_enabled: boolean }[]>`
      insert into users (email, name, password_hash) values (${body.email}, ${body.name}, ${await hashPassword(body.password)})
      returning id, email, name, totp_enabled`;
    return { token: await createSession(sql, config, user!.id, req), user: publicUser(user!) };
  });

  app.post("/auth/login", limited, async (req) => {
    const body = z.object({ email, password: z.string().max(256) }).parse(req.body);
    const [user] = await sql<{ id: string; email: string; name: string; totp_enabled: boolean; password_hash: string }[]>`
      select id, email, name, totp_enabled, password_hash from users where email = ${body.email}`;
    // Same work whether or not the email exists, so response time does not reveal accounts.
    const ok = await verifyPassword(user?.password_hash ?? (await dummyPasswordHash()), body.password);
    if (!user || !ok) throw unauthorized("Wrong email or password", "invalid_credentials");

    if (user.totp_enabled) {
      const mfaToken = newToken();
      await sql`
        insert into mfa_challenges (user_id, token_hash, expires_at)
        values (${user.id}, ${sha256(mfaToken)}, now() + make_interval(mins => ${MFA_CHALLENGE_MINUTES}))`;
      return { mfaRequired: true, mfaToken };
    }
    return { token: await createSession(sql, config, user.id, req), user: publicUser(user) };
  });

  app.post("/auth/login/2fa", limited, async (req) => {
    const body = z.object({ mfaToken: z.string(), code: z.string().trim().min(6).max(20) }).parse(req.body);
    const [challenge] = await sql<{ id: string; user_id: string; attempts: number }[]>`
      update mfa_challenges set attempts = attempts + 1
      where token_hash = ${sha256(body.mfaToken)} and expires_at > now()
      returning id, user_id, attempts`;
    if (!challenge) throw unauthorized("The sign-in attempt expired. Enter your password again.", "mfa_expired");
    if (challenge.attempts > MFA_MAX_ATTEMPTS) {
      await sql`delete from mfa_challenges where id = ${challenge.id}`;
      throw unauthorized("Too many wrong codes. Enter your password again.", "mfa_expired");
    }
    if (!(await verifySecondFactor(challenge.user_id, body.code))) throw unauthorized("Wrong code", "invalid_code");

    await sql`delete from mfa_challenges where id = ${challenge.id}`;
    const [user] = await sql<{ id: string; email: string; name: string; totp_enabled: boolean }[]>`
      select id, email, name, totp_enabled from users where id = ${challenge.user_id}`;
    return { token: await createSession(sql, config, user!.id, req), user: publicUser(user!) };
  });

  app.post("/auth/logout", { preHandler: auth }, async (req) => {
    await sql`delete from sessions where id = ${req.user!.sessionId}`;
    hub.closeSessions([req.user!.sessionId]);
    return { ok: true };
  });

  /* ---------- account ---------- */

  app.get("/me", { preHandler: auth }, async (req) => {
    const u = req.user!;
    const [row] = await sql<{ remaining: number }[]>`
      select count(*)::int as remaining from recovery_codes where user_id = ${u.id} and used_at is null`;
    return { user: { id: u.id, email: u.email, name: u.name, totpEnabled: u.totpEnabled }, recoveryCodesRemaining: row?.remaining ?? 0 };
  });

  app.patch("/me", { preHandler: auth }, async (req) => {
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    const [user] = await sql<{ id: string; email: string; name: string; totp_enabled: boolean }[]>`
      update users set name = ${body.name} where id = ${req.user!.id} returning id, email, name, totp_enabled`;
    return { user: publicUser(user!) };
  });

  app.post("/me/password", { preHandler: auth, ...limited }, async (req) => {
    const body = z.object({ currentPassword: z.string().max(256), newPassword: password }).parse(req.body);
    const [u] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${req.user!.id}`;
    if (!(await verifyPassword(u!.password_hash, body.currentPassword))) throw unauthorized("Current password is wrong", "invalid_credentials");
    await sql`update users set password_hash = ${await hashPassword(body.newPassword)} where id = ${req.user!.id}`;
    // Changing the password signs out every other device.
    const revoked = await sql<{ id: string }[]>`
      delete from sessions where user_id = ${req.user!.id} and id <> ${req.user!.sessionId} returning id`;
    hub.closeSessions(revoked.map((r) => r.id));
    return { ok: true, sessionsRevoked: revoked.length };
  });

  app.get("/me/sessions", { preHandler: auth }, async (req) => {
    const rows = await sql<{ id: string; user_agent: string | null; ip: string | null; created_at: Date; last_used_at: Date }[]>`
      select id, user_agent, ip, created_at, last_used_at from sessions
      where user_id = ${req.user!.id} and expires_at > now() order by last_used_at desc`;
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        lastUsedAt: s.last_used_at,
        current: s.id === req.user!.sessionId,
      })),
    };
  });

  app.delete<{ Params: { id: string } }>("/me/sessions/:id", { preHandler: auth }, async (req) => {
    const id = z.string().uuid().parse(req.params.id);
    const [row] = await sql`delete from sessions where id = ${id} and user_id = ${req.user!.id} returning id`;
    if (!row) throw notFound("Session not found");
    hub.closeSessions([id]);
    return { ok: true };
  });

  /* ---------- two-factor authentication ---------- */

  /** Step 1: generate a secret. 2FA is not active until /enable confirms a code. */
  app.post("/me/2fa/setup", { preHandler: auth }, async (req) => {
    if (req.user!.totpEnabled) throw conflict("Two-factor authentication is already on", "2fa_already_enabled");
    const secret = new Secret({ size: 20 });
    await sql`update users set totp_secret = ${encrypt(config.encryptionKey, secret.base32)} where id = ${req.user!.id}`;
    return { secret: secret.base32, otpauthUrl: totpFor(secret.base32, req.user!.email).toString() };
  });

  /** Step 2: confirm one code from the app. Returns recovery codes (shown once). */
  app.post("/me/2fa/enable", { preHandler: auth, ...limited }, async (req) => {
    const { code } = z.object({ code: otpCode }).parse(req.body);
    if (req.user!.totpEnabled) throw conflict("Two-factor authentication is already on", "2fa_already_enabled");
    const [u] = await sql<{ totp_secret: string | null }[]>`select totp_secret from users where id = ${req.user!.id}`;
    if (!u?.totp_secret) throw badRequest("Start the setup first", "2fa_setup_required");
    const valid = totpFor(decrypt(config.encryptionKey, u.totp_secret), req.user!.email).validate({ token: code, window: 1 }) !== null;
    if (!valid) throw badRequest("Wrong code. Check the time on your phone and try again.", "invalid_code");
    await sql`update users set totp_enabled = true where id = ${req.user!.id}`;
    return { recoveryCodes: await storeRecoveryCodes(req.user!.id) };
  });

  app.post("/me/2fa/disable", { preHandler: auth, ...limited }, async (req) => {
    const body = z.object({ password: z.string().max(256), code: z.string().trim().min(6).max(20) }).parse(req.body);
    const [u] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${req.user!.id}`;
    if (!(await verifyPassword(u!.password_hash, body.password))) throw unauthorized("Wrong password", "invalid_credentials");
    if (!(await verifySecondFactor(req.user!.id, body.code))) throw unauthorized("Wrong code", "invalid_code");
    await sql.begin(async (tx) => {
      await tx`update users set totp_enabled = false, totp_secret = null where id = ${req.user!.id}`;
      await tx`delete from recovery_codes where user_id = ${req.user!.id}`;
    });
    return { ok: true };
  });

  app.post("/me/2fa/recovery-codes", { preHandler: auth, ...limited }, async (req) => {
    const { code } = z.object({ code: otpCode }).parse(req.body);
    if (!req.user!.totpEnabled) throw badRequest("Two-factor authentication is off", "2fa_not_enabled");
    if (!(await verifySecondFactor(req.user!.id, code))) throw unauthorized("Wrong code", "invalid_code");
    return { recoveryCodes: await storeRecoveryCodes(req.user!.id) };
  });
}
