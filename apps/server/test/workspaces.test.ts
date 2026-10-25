import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { collection, reset, setup, signUp, totpNow } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(() => reset(ctx.sql));

async function team() {
  const owner = await signUp(ctx.app, "owner@example.com");
  const admin = await signUp(ctx.app, "admin@example.com");
  const editor = await signUp(ctx.app, "editor@example.com");
  const viewer = await signUp(ctx.app, "viewer@example.com");
  const outsider = await signUp(ctx.app, "outsider@example.com");
  const ws = (await owner.post("/workspaces", { name: "Team" })).body;
  await owner.post(`/workspaces/${ws.id}/members`, { email: "admin@example.com", role: "admin" });
  await owner.post(`/workspaces/${ws.id}/members`, { email: "editor@example.com", role: "editor" });
  await owner.post(`/workspaces/${ws.id}/members`, { email: "viewer@example.com", role: "viewer" });
  return { owner, admin, editor, viewer, outsider, wsId: ws.id as string };
}

describe("workspaces", () => {
  it("creates a workspace owned by the creator and hides it from others", async () => {
    const { owner, outsider, wsId } = await team();
    expect((await owner.get("/workspaces")).body.workspaces).toEqual([expect.objectContaining({ id: wsId, role: "owner" })]);
    expect((await outsider.get("/workspaces")).body.workspaces).toEqual([]);
    expect((await outsider.get(`/workspaces/${wsId}`)).status).toBe(404);
    expect((await outsider.get(`/workspaces/not-a-uuid`)).status).toBe(404);
  });

  it("enforces roles on content", async () => {
    const { editor, viewer, wsId } = await team();
    const c = collection();
    expect((await viewer.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 })).status).toBe(403);
    expect((await editor.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 })).body).toEqual({ version: 1, conflicts: [] });
    const snapshot = (await viewer.get(`/workspaces/${wsId}`)).body;
    expect(snapshot.collections).toEqual([{ collection: c, version: 1 }]);
    expect(snapshot.workspace.role).toBe("viewer");
    expect((await editor.patch(`/workspaces/${wsId}`, { name: "x" })).status).toBe(403);
  });

  it("reports a concurrent edit of the same setting and keeps the server copy", async () => {
    const { owner, editor, wsId } = await team();
    const c = collection();
    await owner.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 });
    expect((await owner.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: { ...c, name: "A" }, baseVersion: 1 })).body.version).toBe(2);
    const stale = await editor.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: { ...c, name: "B" }, baseVersion: 1 });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ version: 2, merged: { name: "A" }, conflicts: [{ kind: "collection", reason: "both_changed" }] });
    // Creating an id that already exists is also a conflict.
    expect((await editor.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 })).status).toBe(409);
  });

  it("never stores secret or local variable values", async () => {
    const { owner, wsId } = await team();
    const c = collection("API", {
      variables: [
        { id: "1", key: "host", value: "api.dev", localValue: "my-machine", enabled: true, secret: false },
        { id: "2", key: "password", value: "s3cret", enabled: true, secret: true },
      ],
    });
    await owner.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 });
    const env = { id: crypto.randomUUID(), name: "Prod", variables: [{ id: "3", key: "token", value: "t0k3n", enabled: true, secret: true }] };
    await owner.put(`/workspaces/${wsId}/environments/${env.id}`, { environment: env, baseVersion: 0 });
    await owner.put(`/workspaces/${wsId}/globals`, { variables: [{ id: "4", key: "g", value: "x", localValue: "y", enabled: true, secret: false }], baseVersion: 1 });

    const dump = JSON.stringify(await ctx.sql`select data from collections union all select data from environments union all select globals from workspaces`);
    expect(dump).not.toMatch(/s3cret|t0k3n|my-machine|"y"/);
    expect(dump).toContain("api.dev");
  });

  it("deletes collections and environments", async () => {
    const { editor, wsId } = await team();
    const c = collection();
    await editor.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 });
    expect((await editor.del(`/workspaces/${wsId}/collections/${c.id}`)).status).toBe(200);
    expect((await editor.del(`/workspaces/${wsId}/collections/${c.id}`)).status).toBe(404);
  });

  it("only the owner deletes the workspace", async () => {
    const { owner, admin, wsId } = await team();
    expect((await admin.del(`/workspaces/${wsId}`)).status).toBe(403);
    expect((await owner.del(`/workspaces/${wsId}`)).status).toBe(200);
    expect((await owner.get(`/workspaces/${wsId}`)).status).toBe(404);
  });
});

describe("members", () => {
  it("adds existing accounts only, once", async () => {
    const { owner, wsId } = await team();
    expect((await owner.post(`/workspaces/${wsId}/members`, { email: "editor@example.com", role: "viewer" })).body.error.code).toBe("already_member");
    expect((await owner.post(`/workspaces/${wsId}/members`, { email: "outsider@example.com", role: "owner" })).body.error.code).toBe("validation");
  });

  it("lets admins grant admin but not touch other admins or the owner", async () => {
    const { owner, admin, editor, viewer, wsId } = await team();
    expect((await admin.patch(`/workspaces/${wsId}/members/${viewer.user.id}`, { role: "admin" })).status).toBe(200);
    expect((await admin.patch(`/workspaces/${wsId}/members/${viewer.user.id}`, { role: "editor" })).status).toBe(403);
    expect((await admin.patch(`/workspaces/${wsId}/members/${owner.user.id}`, { role: "viewer" })).status).toBe(403);
    expect((await admin.del(`/workspaces/${wsId}/members/${viewer.user.id}`)).status).toBe(403);
    expect((await editor.patch(`/workspaces/${wsId}/members/${viewer.user.id}`, { role: "viewer" })).status).toBe(403);
    expect((await owner.patch(`/workspaces/${wsId}/members/${admin.user.id}`, { role: "editor" })).status).toBe(200);
  });

  it("removes members, lets them leave, and keeps the owner", async () => {
    const { owner, admin, editor, viewer, wsId } = await team();
    expect((await admin.del(`/workspaces/${wsId}/members/${editor.user.id}`)).status).toBe(200);
    expect((await editor.get(`/workspaces/${wsId}`)).status).toBe(404);
    expect((await viewer.del(`/workspaces/${wsId}/members/${viewer.user.id}`)).status).toBe(200);
    expect((await owner.del(`/workspaces/${wsId}/members/${owner.user.id}`)).status).toBe(403);
  });

  it("transfers ownership", async () => {
    const { owner, editor, outsider, wsId } = await team();
    expect((await owner.post(`/workspaces/${wsId}/transfer`, { userId: outsider.user.id })).status).toBe(404);
    const res = await owner.post(`/workspaces/${wsId}/transfer`, { userId: editor.user.id });
    const roles = Object.fromEntries(res.body.members.map((m: { email: string; role: string }) => [m.email, m.role]));
    expect(roles["editor@example.com"]).toBe("owner");
    expect(roles["owner@example.com"]).toBe("admin");
    expect((await owner.del(`/workspaces/${wsId}`)).status).toBe(403);
  });

  it("can require 2FA for every member", async () => {
    const { owner, editor, wsId } = await team();
    expect((await owner.patch(`/workspaces/${wsId}`, { require2fa: true })).body.error.code).toBe("two_factor_required");
    const { secret } = (await owner.post("/me/2fa/setup")).body;
    await owner.post("/me/2fa/enable", { code: totpNow(secret) });
    expect((await owner.patch(`/workspaces/${wsId}`, { require2fa: true })).status).toBe(200);
    expect((await editor.get(`/workspaces/${wsId}`)).body.error.code).toBe("two_factor_required");
    expect((await owner.get(`/workspaces/${wsId}`)).status).toBe(200);
  });

  it("records an audit log visible to admins", async () => {
    const { owner, admin, editor, wsId } = await team();
    await owner.patch(`/workspaces/${wsId}/members/${editor.user.id}`, { role: "viewer" });
    const log = (await admin.get(`/workspaces/${wsId}/audit`)).body.entries;
    expect(log[0]).toMatchObject({ action: "member.role_changed", actorEmail: "owner@example.com", details: { from: "editor", to: "viewer" } });
    expect(log.map((e: { action: string }) => e.action)).toContain("workspace.created");
    expect((await editor.get(`/workspaces/${wsId}/audit`)).status).toBe(403);
  });
});

describe("realtime", () => {
  let base: string;
  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = ctx.app.server.address() as { port: number };
    base = `ws://127.0.0.1:${addr.port}/ws`;
  });

  /** Opens a socket, authenticates and subscribes; collects every event. */
  async function connect(token: string, workspaceId: string) {
    const ws = new WebSocket(base);
    const events: any[] = [];
    let closed: number | undefined;
    ws.on("message", (d) => events.push(JSON.parse(d.toString())));
    ws.on("close", (code) => (closed = code));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => events.some((e) => e.type === "ready"));
    ws.send(JSON.stringify({ type: "subscribe", workspaceId }));
    await waitFor(() => events.some((e) => e.type === "subscribed" || e.type === "error"));
    return { ws, events, closed: () => closed };
  }

  async function waitFor(check: () => boolean, ms = 3000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it("pushes edits to other members and revokes removed ones", async () => {
    const { owner, editor, viewer, outsider, wsId } = await team();
    const viewerSock = await connect(viewer.token!, wsId);
    const outsiderSock = await connect(outsider.token!, wsId);
    expect(outsiderSock.events.at(-1)).toMatchObject({ type: "error", code: "not_found" });

    const c = collection("Live");
    await editor.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: c, baseVersion: 0 });
    await waitFor(() => viewerSock.events.some((e) => e.type === "collection.put"));
    expect(viewerSock.events.find((e) => e.type === "collection.put")).toMatchObject({ collection: { name: "Live" }, version: 1, by: editor.user.id });
    expect(outsiderSock.events.some((e) => e.type === "collection.put")).toBe(false);

    await owner.del(`/workspaces/${wsId}/members/${viewer.user.id}`);
    await waitFor(() => viewerSock.events.some((e) => e.type === "workspace.removed"));
    await editor.del(`/workspaces/${wsId}/collections/${c.id}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(viewerSock.events.some((e) => e.type === "collection.deleted")).toBe(false);

    viewerSock.ws.close();
    outsiderSock.ws.close();
  });

  it("tells a user when they are added to a workspace", async () => {
    const { owner, outsider, wsId } = await team();
    const sock = await connect(outsider.token!, wsId);
    await owner.post(`/workspaces/${wsId}/members`, { email: "outsider@example.com", role: "viewer" });
    await waitFor(() => sock.events.some((e) => e.type === "workspace.added" && e.workspaceId === wsId));
    sock.ws.close();
  });

  it("closes the socket when the session is revoked", async () => {
    const { editor, wsId } = await team();
    const sock = await connect(editor.token!, wsId);
    await editor.post("/auth/logout");
    await waitFor(() => sock.closed() === 4401);
  });

  it("rejects sockets without a valid token", async () => {
    const ws = new WebSocket(base);
    let code: number | undefined;
    ws.on("close", (c) => (code = c));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "auth", token: "nope" }));
    await waitFor(() => code === 4401);
  });
});
