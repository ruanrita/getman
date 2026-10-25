import { randomInt } from "node:crypto";
import type { Sql } from "./db";
import { newRecoveryCodes, normalizeRecoveryCode, safeEqual, sha256 } from "./crypto";
import { HttpError } from "./errors";
import { templates, type Mailer } from "./mail";
import type { Hub } from "./realtime";

export type CodePurpose = "verify" | "reset";

const CODE_MINUTES = 30;
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
export const INVITE_DAYS = 7;

const codeHash = (purpose: CodePurpose, email: string, code: string) => sha256(`${purpose}:${email}:${code.trim()}`);
export const inviteHash = (code: string) => sha256(`invite:${normalizeRecoveryCode(code)}`);

/** Email codes and invitations, shared by the auth and workspace routes. */
export function emailService(sql: Sql, mailer: Mailer | undefined, hub: Hub) {
  async function send(to: string, mail: { subject: string; text: string }) {
    try {
      await mailer!.send({ to, ...mail });
    } catch (e) {
      throw new HttpError(502, "email_failed", `The server could not send the email (${(e as Error).message}). Ask the administrator to check the SMTP settings.`);
    }
  }

  return {
    enabled: Boolean(mailer),

    /**
     * Emails a fresh code (verify: 6 digits, reset: 8 digits), invalidating older ones.
     * At most one per minute per address and purpose.
     */
    async issueCode(email: string, purpose: CodePurpose): Promise<"sent" | "cooldown" | "disabled"> {
      if (!mailer) return "disabled";
      const [recent] = await sql`
        select 1 from email_codes where email = ${email} and purpose = ${purpose} and created_at > now() - make_interval(secs => ${COOLDOWN_SECONDS})`;
      if (recent) return "cooldown";
      const code = purpose === "verify" ? String(randomInt(0, 1e6)).padStart(6, "0") : String(randomInt(0, 1e8)).padStart(8, "0");
      await sql`update email_codes set used_at = now() where email = ${email} and purpose = ${purpose} and used_at is null`;
      await sql`
        insert into email_codes (email, purpose, code_hash, expires_at)
        values (${email}, ${purpose}, ${codeHash(purpose, email, code)}, now() + make_interval(mins => ${CODE_MINUTES}))`;
      await send(email, templates[purpose](code));
      return "sent";
    },

    /** Checks the newest live code; each attempt counts, and the code is single-use. */
    async consumeCode(email: string, purpose: CodePurpose, code: string): Promise<boolean> {
      const [row] = await sql<{ id: string; attempts: number; code_hash: string }[]>`
        update email_codes set attempts = attempts + 1
        where id = (
          select id from email_codes where email = ${email} and purpose = ${purpose} and used_at is null and expires_at > now()
          order by created_at desc limit 1)
        returning id, attempts, code_hash`;
      if (!row) return false;
      const ok = row.attempts <= MAX_ATTEMPTS && safeEqual(row.code_hash, codeHash(purpose, email, code));
      if (ok || row.attempts >= MAX_ATTEMPTS) await sql`update email_codes set used_at = now() where id = ${row.id}`;
      return ok;
    },

    /** Creates (or replaces) a pending invitation and emails it when possible. Returns the code. */
    async createInvite(p: { workspaceId: string; workspaceName: string; email: string; role: string; inviterId: string; inviterName: string; serverUrl: string }) {
      const code = newRecoveryCodes(1)[0]!;
      await sql`delete from invites where workspace_id = ${p.workspaceId} and email = ${p.email} and accepted_at is null`;
      const [invite] = await sql<{ id: string; expiresAt: Date }[]>`
        insert into invites (workspace_id, email, role, code_hash, invited_by, expires_at)
        values (${p.workspaceId}, ${p.email}, ${p.role}, ${inviteHash(code)}, ${p.inviterId}, now() + make_interval(days => ${INVITE_DAYS}))
        returning id, expires_at as "expiresAt"`;
      let emailSent = false;
      if (mailer) {
        await send(p.email, templates.invite({ inviter: p.inviterName, workspace: p.workspaceName, role: p.role, code, serverUrl: p.serverUrl }));
        emailSent = true;
      }
      return { id: invite!.id, expiresAt: invite!.expiresAt, code, emailSent };
    },

    /** Adds the user to every workspace with a live invitation for their (verified) email. */
    async acceptPendingInvites(user: { id: string; email: string }) {
      const invites = await sql<{ id: string; workspace_id: string; role: string }[]>`
        select id, workspace_id, role from invites where email = ${user.email} and accepted_at is null and expires_at > now()`;
      const joined: { id: string; name: string; role: string }[] = [];
      for (const inv of invites) joined.push(await this.accept(user, inv));
      return joined;
    },

    async accept(user: { id: string; email: string }, inv: { id: string; workspace_id: string; role: string }) {
      await sql`insert into members (workspace_id, user_id, role) values (${inv.workspace_id}, ${user.id}, ${inv.role}) on conflict do nothing`;
      await sql`update invites set accepted_at = now(), accepted_by = ${user.id} where id = ${inv.id}`;
      await sql`insert into audit_log (workspace_id, actor_id, action, details)
        values (${inv.workspace_id}, ${user.id}, 'invite.accepted', ${sql.json({ email: user.email, role: inv.role } as never)})`;
      hub.publish({ type: "members.updated", workspaceId: inv.workspace_id, by: user.id });
      hub.notifyUser(user.id, { type: "workspace.added", workspaceId: inv.workspace_id });
      const [ws] = await sql<{ name: string }[]>`select name from workspaces where id = ${inv.workspace_id}`;
      return { id: inv.workspace_id, name: ws?.name ?? "", role: inv.role };
    },
  };
}

export type EmailService = ReturnType<typeof emailService>;
