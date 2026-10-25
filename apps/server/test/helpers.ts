import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secret, TOTP } from "otpauth";
import { buildApp } from "../src/app";
import type { Config } from "../src/config";
import { connect, migrate, type Sql } from "../src/db";
import type { Mail } from "../src/mail";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://getman:getman@localhost:55432/getman_test";

export const config: Config = {
  port: 0,
  host: "127.0.0.1",
  databaseUrl: TEST_DB,
  encryptionKey: randomBytes(32),
  sessionTtlDays: 30,
  corsOrigins: ["http://localhost:1420"],
  trustProxy: false,
  authRateLimit: 1000,
  // Tests talk to local Postgres / S3 / fake AI servers.
  allowPrivateNetworks: true,
  backupDir: join(tmpdir(), `getman-test-backups-${process.pid}`),
  mailFrom: "Getman Test <test@getman.local>",
};

/** Emails the server sent during the tests (in-memory mailer). */
export const outbox: Mail[] = [];

/** The code in the newest email to `to` (6-8 digits, or an invite code). */
export function lastCode(to: string): string {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  const code = mail?.text.match(/^\s{4}(\S+)$/m)?.[1];
  if (!code) throw new Error(`no code emailed to ${to}`);
  return code;
}

export async function setup(overrides: Partial<Config> = {}, opts: { email?: boolean } = {}) {
  const sql = connect(TEST_DB);
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql);
  const mailer = opts.email === false ? null : { send: async (m: Mail) => void outbox.push(m) };
  const { app, hub } = await buildApp(sql, { ...config, ...overrides }, { mailer });
  return { sql, app, hub };
}

export async function reset(sql: Sql) {
  await sql`truncate users, workspaces, audit_log, email_codes restart identity cascade`;
}

type App = Awaited<ReturnType<typeof setup>>["app"];

/** Small JSON client over app.inject. */
export function client(app: App) {
  let token: string | undefined;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: body as object,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.statusCode, body: res.json() as any };
  };
  return {
    get token() {
      return token;
    },
    set token(t: string | undefined) {
      token = t;
    },
    get: (url: string) => call("GET", url),
    post: (url: string, body?: unknown) => call("POST", url, body ?? {}),
    put: (url: string, body?: unknown) => call("PUT", url, body),
    patch: (url: string, body?: unknown) => call("PATCH", url, body),
    del: (url: string) => call("DELETE", url),
  };
}

export async function signUp(app: App, email: string, name = email.split("@")[0]!) {
  const c = client(app);
  const res = await c.post("/auth/register", { email, password: "correct horse battery", name });
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  c.token = res.body.token;
  return Object.assign(c, { user: res.body.user as { id: string; email: string } });
}

export const totpNow = (secret: string) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" }).generate();

export function collection(name = "API", extra: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    name,
    items: [],
    variables: [] as { id: string; key: string; value: string; enabled: boolean; secret: boolean; localValue?: string }[],
    auth: { type: "none" },
    scripts: { preRequest: "", test: "" },
    ...extra,
  };
}
