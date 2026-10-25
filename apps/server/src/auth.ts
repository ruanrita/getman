import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config";
import { newToken, sha256 } from "./crypto";
import type { Sql } from "./db";
import { unauthorized } from "./errors";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  emailVerified: boolean;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  emailVerified: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  totp_enabled: boolean;
  email_verified_at: Date | null;
}

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  totpEnabled: u.totp_enabled,
  emailVerified: Boolean(u.email_verified_at),
});

export async function createSession(sql: Sql, config: Config, userId: string, req: FastifyRequest): Promise<string> {
  const token = newToken();
  await sql`
    insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
    values (${userId}, ${sha256(token)}, ${req.headers["user-agent"]?.slice(0, 300) ?? null}, ${req.ip},
            now() + make_interval(days => ${config.sessionTtlDays}))`;
  return token;
}

/** Resolves a bearer token to a user, extending the session (sliding expiry). */
export async function userFromToken(sql: Sql, config: Config, token: string): Promise<AuthUser | undefined> {
  const [row] = await sql<
    { session_id: string; id: string; email: string; name: string; totp_enabled: boolean; email_verified_at: Date | null; last_used_at: Date }[]
  >`
    select s.id as session_id, s.last_used_at, u.id, u.email, u.name, u.totp_enabled, u.email_verified_at
    from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
  if (!row) return undefined;
  // Avoid a write on every request: refresh at most once a minute.
  if (Date.now() - row.last_used_at.getTime() > 60_000) {
    await sql`
      update sessions set last_used_at = now(), expires_at = now() + make_interval(days => ${config.sessionTtlDays})
      where id = ${row.session_id}`;
  }
  return { id: row.id, email: row.email, name: row.name, totpEnabled: row.totp_enabled, emailVerified: Boolean(row.email_verified_at), sessionId: row.session_id };
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/** preHandler for routes that need a signed-in user. */
export function requireAuth(sql: Sql, config: Config) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = bearer(req);
    const user = token ? await userFromToken(sql, config, token) : undefined;
    if (!user) throw unauthorized("Your session has expired. Sign in again.", "session_expired");
    req.user = user;
  };
}
