import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, reset, setup, signUp, totpNow } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(() => reset(ctx.sql));

describe("http", () => {
  it("allows every API method from configured browser origins only", async () => {
    const preflight = (origin: string) =>
      ctx.app.inject({
        method: "OPTIONS",
        url: "/workspaces/x/collections/y",
        headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,content-type" },
      });
    const ok = await preflight("http://localhost:1420");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:1420");
    expect(String(ok.headers["access-control-allow-methods"])).toMatch(/PUT/);
    expect(String(ok.headers["access-control-allow-methods"])).toMatch(/DELETE/);
    expect((await preflight("https://evil.example")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("accounts", () => {
  it("registers, signs in and reads /me", async () => {
    const ana = await signUp(ctx.app, "Ana@Example.com", "Ana");
    expect(ana.user.email).toBe("ana@example.com");
    const me = await ana.get("/me");
    expect(me.body.user).toMatchObject({ email: "ana@example.com", name: "Ana", totpEnabled: false });

    const anon = client(ctx.app);
    const login = await anon.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it("rejects bad input, duplicates and wrong passwords with stable codes", async () => {
    const anon = client(ctx.app);
    expect((await anon.post("/auth/register", { email: "x@y.z", password: "short", name: "X" })).body.error.code).toBe("validation");
    await signUp(ctx.app, "ana@example.com");
    expect((await anon.post("/auth/register", { email: "ana@example.com", password: "long enough pw", name: "A" })).body.error.code).toBe("email_taken");
    const wrong = await anon.post("/auth/login", { email: "ana@example.com", password: "nope nope nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("invalid_credentials");
    const unknown = await anon.post("/auth/login", { email: "ghost@example.com", password: "nope nope nope" });
    expect(unknown.body.error.code).toBe("invalid_credentials");
  });

  it("requires a valid token", async () => {
    const anon = client(ctx.app);
    expect((await anon.get("/me")).status).toBe(401);
    anon.token = "forged";
    expect((await anon.get("/me")).body.error.code).toBe("session_expired");
  });

  it("logs out and revokes sessions", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    const laptop = client(ctx.app);
    laptop.token = (await laptop.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" })).body.token;

    const sessions = (await ana.get("/me/sessions")).body.sessions;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s: { current: boolean }) => !s.current);
    expect((await ana.del(`/me/sessions/${other.id}`)).status).toBe(200);
    expect((await laptop.get("/me")).status).toBe(401);

    expect((await ana.post("/auth/logout")).status).toBe(200);
    expect((await ana.get("/me")).status).toBe(401);
  });

  it("changing the password signs out other devices", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    const laptop = client(ctx.app);
    laptop.token = (await laptop.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" })).body.token;
    expect((await ana.post("/me/password", { currentPassword: "wrong", newPassword: "another long pw" })).status).toBe(401);
    const res = await ana.post("/me/password", { currentPassword: "correct horse battery", newPassword: "another long pw" });
    expect(res.body.sessionsRevoked).toBe(1);
    expect((await laptop.get("/me")).status).toBe(401);
    expect((await ana.get("/me")).status).toBe(200);
  });
});

describe("two-factor authentication", () => {
  async function enable2fa() {
    const ana = await signUp(ctx.app, "ana@example.com");
    const setup = (await ana.post("/me/2fa/setup")).body;
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Getman:ana%40example\.com\?/);
    expect((await ana.post("/me/2fa/enable", { code: "000000" })).body.error.code).toBe("invalid_code");
    const enabled = await ana.post("/me/2fa/enable", { code: totpNow(setup.secret) });
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    return { ana, secret: setup.secret as string, recoveryCodes: enabled.body.recoveryCodes as string[] };
  }

  it("asks for a code after the password and accepts a TOTP code", async () => {
    const { secret } = await enable2fa();
    const anon = client(ctx.app);
    const step1 = await anon.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" });
    expect(step1.body).toMatchObject({ mfaRequired: true });
    expect(step1.body.token).toBeUndefined();

    expect((await anon.post("/auth/login/2fa", { mfaToken: step1.body.mfaToken, code: "123456" })).body.error.code).toBe("invalid_code");
    const step2 = await anon.post("/auth/login/2fa", { mfaToken: step1.body.mfaToken, code: totpNow(secret) });
    expect(step2.status).toBe(200);
    expect(step2.body.user.totpEnabled).toBe(true);
    // The challenge is single use.
    expect((await anon.post("/auth/login/2fa", { mfaToken: step1.body.mfaToken, code: totpNow(secret) })).body.error.code).toBe("mfa_expired");
  });

  it("accepts each recovery code once", async () => {
    const { recoveryCodes } = await enable2fa();
    const anon = client(ctx.app);
    const login = async () => (await anon.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" })).body.mfaToken;
    const code = recoveryCodes[0]!.toUpperCase(); // case and dashes do not matter
    expect((await anon.post("/auth/login/2fa", { mfaToken: await login(), code })).status).toBe(200);
    expect((await anon.post("/auth/login/2fa", { mfaToken: await login(), code })).body.error.code).toBe("invalid_code");
    expect((await anon.get("/me")).status).toBe(401);
  });

  it("locks the challenge after too many wrong codes", async () => {
    await enable2fa();
    const anon = client(ctx.app);
    const { mfaToken } = (await anon.post("/auth/login", { email: "ana@example.com", password: "correct horse battery" })).body;
    for (let i = 0; i < 5; i++) await anon.post("/auth/login/2fa", { mfaToken, code: "000000" });
    expect((await anon.post("/auth/login/2fa", { mfaToken, code: "000000" })).body.error.code).toBe("mfa_expired");
  });

  it("disables only with password and code", async () => {
    const { ana, secret } = await enable2fa();
    expect((await ana.post("/me/2fa/disable", { password: "wrong", code: totpNow(secret) })).status).toBe(401);
    expect((await ana.post("/me/2fa/disable", { password: "correct horse battery", code: totpNow(secret) })).status).toBe(200);
    const login = await client(ctx.app).post("/auth/login", { email: "ana@example.com", password: "correct horse battery" });
    expect(login.body.token).toBeTruthy();
  });

  it("stores the TOTP secret encrypted", async () => {
    const { secret } = await enable2fa();
    const [row] = await ctx.sql<{ totp_secret: string }[]>`select totp_secret from users`;
    expect(row!.totp_secret).not.toContain(secret);
  });
});
