import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, lastCode, outbox, reset, setup, signUp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(async () => {
  outbox.length = 0;
  await reset(ctx.sql);
});

const login = (email: string, password: string) => client(ctx.app).post("/auth/login", { email, password });
/** Codes are rate limited to one per minute per address; tests move time forward instead of waiting. */
const skipCooldown = () => ctx.sql`update email_codes set created_at = created_at - interval '2 minutes'`;

describe("email verification", () => {
  it("sends a code on sign up and verifies with it", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    expect(ana.user).toMatchObject({ emailVerified: false });
    expect(outbox.at(-1)).toMatchObject({ to: "ana@example.com", subject: expect.stringMatching(/verification code: \d{6}/) });

    expect((await ana.post("/me/email/verify", { code: "000000" })).body.error.code).toBe("invalid_code");
    expect((await ana.post("/me/email/verify", { code: lastCode("ana@example.com") })).body).toMatchObject({ ok: true });
    expect((await ana.get("/me")).body.user.emailVerified).toBe(true);
    expect((await ana.post("/me/email/send-code")).body.error.code).toBe("already_verified");
  });

  it("limits resends and invalidates older codes", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    const first = lastCode("ana@example.com");
    expect((await ana.post("/me/email/send-code")).body.error.code).toBe("cooldown");
    await skipCooldown();
    expect((await ana.post("/me/email/send-code")).status).toBe(200);
    const second = lastCode("ana@example.com");
    if (first !== second) expect((await ana.post("/me/email/verify", { code: first })).body.error.code).toBe("invalid_code");
    expect((await ana.post("/me/email/verify", { code: second })).status).toBe(200);
  });

  it("burns a code after 5 wrong attempts", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    const code = lastCode("ana@example.com");
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await ana.post("/me/email/verify", { code: wrong });
    expect((await ana.post("/me/email/verify", { code })).body.error.code).toBe("invalid_code");
  });
});

describe("password reset", () => {
  it("resets with an emailed code and signs out everywhere", async () => {
    const ana = await signUp(ctx.app, "ana@example.com");
    await skipCooldown();
    const forgot = await client(ctx.app).post("/auth/password/forgot", { email: "ANA@example.com" });
    expect(forgot.body).toEqual({ ok: true, emailEnabled: true });
    const code = lastCode("ana@example.com");
    expect(code).toMatch(/^\d{8}$/);

    const bad = await client(ctx.app).post("/auth/password/reset", { email: "ana@example.com", code: "00000000", newPassword: "brand new password" });
    expect(bad.body.error.code).toBe("invalid_code");
    const ok = await client(ctx.app).post("/auth/password/reset", { email: "ana@example.com", code, newPassword: "brand new password" });
    expect(ok.status).toBe(200);

    expect((await ana.get("/me")).status).toBe(401); // old session revoked
    expect((await login("ana@example.com", "correct horse battery")).status).toBe(401);
    const fresh = await login("ana@example.com", "brand new password");
    expect(fresh.body.user.emailVerified).toBe(true); // the code proved the inbox
    // Single use.
    expect((await client(ctx.app).post("/auth/password/reset", { email: "ana@example.com", code, newPassword: "another password!" })).status).toBe(400);
  });

  it("does not reveal whether an account exists", async () => {
    const res = await client(ctx.app).post("/auth/password/forgot", { email: "ghost@example.com" });
    expect(res.body).toEqual({ ok: true, emailEnabled: true });
    expect(outbox).toHaveLength(0);
  });
});

describe("invitations", () => {
  async function owner() {
    const o = await signUp(ctx.app, "owner@example.com", "Olivia");
    const ws = (await o.post("/workspaces", { name: "Payments" })).body;
    return { o, wsId: ws.id as string };
  }

  it("invites an email without an account and joins on verification", async () => {
    const { o, wsId } = await owner();
    const res = await o.post(`/workspaces/${wsId}/members`, { email: "New@Example.com", role: "editor" });
    expect(res.body).toMatchObject({ emailSent: true, invite: { email: "new@example.com", role: "editor" } });
    expect(res.body.code).toMatch(/^\w{4}-\w{4}-\w{4}$/);
    const mail = outbox.at(-1)!;
    expect(mail).toMatchObject({ to: "new@example.com", subject: 'Olivia invited you to "Payments" on Getman' });
    expect(mail.text).toContain(res.body.code);
    expect((await o.get(`/workspaces/${wsId}/invites`)).body.invites).toHaveLength(1);

    // Signing up alone is not enough: the address must be proven.
    const newbie = await signUp(ctx.app, "new@example.com");
    expect((await newbie.get("/workspaces")).body.workspaces).toEqual([]);
    const verified = await newbie.post("/me/email/verify", { code: lastCode("new@example.com") });
    expect(verified.body.joined).toEqual([{ id: wsId, name: "Payments", role: "editor" }]);
    expect((await newbie.get("/workspaces")).body.workspaces[0]).toMatchObject({ id: wsId, role: "editor" });
    expect((await o.get(`/workspaces/${wsId}/invites`)).body.invites).toHaveLength(0);
    const audit = (await o.get(`/workspaces/${wsId}/audit`)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(["invite.created", "invite.accepted"]));
  });

  it("accepts by code only for the invited address", async () => {
    const { o, wsId } = await owner();
    const { code } = (await o.post(`/workspaces/${wsId}/members`, { email: "bob@example.com", role: "viewer" })).body;
    const mallory = await signUp(ctx.app, "mallory@example.com");
    expect((await mallory.post("/invites/accept", { code })).body.error.code).toBe("invite_email_mismatch");
    const bob = await signUp(ctx.app, "bob@example.com");
    expect((await bob.post("/invites/accept", { code: code.toUpperCase() })).body.joined[0]).toMatchObject({ id: wsId, role: "viewer" });
    expect((await bob.post("/invites/accept", { code })).status).toBe(404); // used
  });

  it("resends with a new code and can be revoked", async () => {
    const { o, wsId } = await owner();
    const first = (await o.post(`/workspaces/${wsId}/members`, { email: "bob@example.com", role: "viewer" })).body;
    const again = (await o.post(`/workspaces/${wsId}/invites/${first.invite.id}/resend`)).body;
    expect(again.code).not.toBe(first.code);
    const bob = await signUp(ctx.app, "bob@example.com");
    expect((await bob.post("/invites/accept", { code: first.code })).status).toBe(404);
    expect((await o.del(`/workspaces/${wsId}/invites/${again.invite.id}`)).status).toBe(200);
    expect((await bob.post("/invites/accept", { code: again.code })).status).toBe(404);
  });

  it("only admins can invite or see invitations", async () => {
    const { o, wsId } = await owner();
    const viewer = await signUp(ctx.app, "viewer@example.com");
    await o.post(`/workspaces/${wsId}/members`, { email: "viewer@example.com", role: "viewer" });
    expect((await viewer.post(`/workspaces/${wsId}/members`, { email: "x@example.com", role: "viewer" })).status).toBe(403);
    expect((await viewer.get(`/workspaces/${wsId}/invites`)).status).toBe(403);
  });
});

describe("without SMTP", () => {
  it("invites still work through the code, and health reports email off", async () => {
    const noMail = await setup({}, { email: false });
    try {
      expect((await noMail.app.inject({ method: "GET", url: "/health" })).json().features).toEqual({ email: false });
      const o = await signUp(noMail.app, "owner@example.com");
      const ws = (await o.post("/workspaces", { name: "W" })).body;
      const res = await o.post(`/workspaces/${ws.id}/members`, { email: "bob@example.com", role: "editor" });
      expect(res.body).toMatchObject({ emailSent: false });
      const bob = await signUp(noMail.app, "bob@example.com");
      expect((await bob.post("/me/email/send-code")).body.error.code).toBe("email_disabled");
      expect((await bob.post("/invites/accept", { code: res.body.code })).status).toBe(200);
      expect((await client(noMail.app).post("/auth/password/forgot", { email: "bob@example.com" })).body).toEqual({ ok: true, emailEnabled: false });
    } finally {
      await noMail.app.close();
      await noMail.sql.end();
    }
  });
});
