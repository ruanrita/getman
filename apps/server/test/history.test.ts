import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collection, reset, setup, signUp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(() => reset(ctx.sql));

const request = (name: string, url = "/x") => ({
  kind: "request",
  id: crypto.randomUUID(),
  name,
  method: "GET",
  url,
  params: [],
  headers: [],
  body: { mode: "none", raw: "", form: [] },
  auth: { type: "inherit" },
  scripts: { preRequest: "", test: "" },
});

async function team() {
  const ana = await signUp(ctx.app, "ana@example.com", "Ana");
  const bob = await signUp(ctx.app, "bob@example.com", "Bob");
  const viewer = await signUp(ctx.app, "viewer@example.com", "Vic");
  const ws = (await ana.post("/workspaces", { name: "W" })).body;
  await ana.post(`/workspaces/${ws.id}/members`, { email: "bob@example.com", role: "editor" });
  await ana.post(`/workspaces/${ws.id}/members`, { email: "viewer@example.com", role: "viewer" });
  const login = request("Login", "/login");
  const list = request("List", "/items");
  const c = collection("API", { items: [login, list] });
  await ana.put(`/workspaces/${ws.id}/collections/${c.id}`, { collection: c, baseVersion: 0 });
  return { ana, bob, viewer, wsId: ws.id as string, c, login, list };
}

const withUrl = (c: ReturnType<typeof collection>, id: string, url: string) => ({
  ...c,
  items: (c.items as ReturnType<typeof request>[]).map((i) => (i.id === id ? { ...i, url } : i)),
});

describe("merge on save", () => {
  it("merges edits to different requests saved from the same version", async () => {
    const { ana, bob, wsId, c, login, list } = await team();
    await ana.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, login.id, "/v2/login"), baseVersion: 1 });
    const res = await bob.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, list.id, "/v2/items"), baseVersion: 1 });
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.version).toBe(3);
    const stored = (await ana.get(`/workspaces/${wsId}`)).body.collections[0].collection;
    expect(stored.items.map((i: { url: string }) => i.url)).toEqual(["/v2/login", "/v2/items"]);
    expect(res.body.merged.items.map((i: { url: string }) => i.url)).toEqual(["/v2/login", "/v2/items"]);
  });

  it("reports the same request changed by both and keeps the first save", async () => {
    const { ana, bob, wsId, c, list } = await team();
    await ana.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, list.id, "/ana"), baseVersion: 1 });
    const res = await bob.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, list.id, "/bob"), baseVersion: 1 });
    expect(res.body.conflicts).toEqual([{ kind: "request", id: list.id, name: "List", reason: "both_changed" }]);
    expect(res.body.version).toBe(2); // nothing new to store
    expect((await ana.get(`/workspaces/${wsId}`)).body.collections[0].collection.items[1].url).toBe("/ana");
  });
});

describe("history", () => {
  it("lists versions with what changed, per collection and per request", async () => {
    const { ana, bob, wsId, c, list } = await team();
    await ana.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, list.id, "/v2"), baseVersion: 1 });
    await bob.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: { ...withUrl(c, list.id, "/v2"), items: [withUrl(c, list.id, "/v2").items[1]] }, baseVersion: 2 });

    const versions = (await ana.get(`/workspaces/${wsId}/collections/${c.id}/versions`)).body.versions;
    expect(versions.map((v: { version: number; savedBy: string }) => `${v.version}:${v.savedBy}`)).toEqual(["3:Bob", "2:Ana", "1:Ana"]);
    expect(versions[0].changes).toEqual([{ id: expect.any(String), name: "Login", change: "deleted" }]);
    expect(versions[1].changes).toEqual([{ id: list.id, name: "List", change: "changed" }]);

    const history = (await ana.get(`/workspaces/${wsId}/collections/${c.id}/items/${list.id}/history`)).body.history;
    expect(history.map((h: { version: number; change: string; item: { url: string } }) => `${h.version}:${h.change}:${h.item.url}`)).toEqual(["2:changed:/v2", "1:created:/items"]);
  });

  it("restores an old version as a new version", async () => {
    const { ana, viewer, wsId, c, list } = await team();
    await ana.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: withUrl(c, list.id, "/broken"), baseVersion: 1 });
    expect((await viewer.post(`/workspaces/${wsId}/collections/${c.id}/versions/1/restore`)).status).toBe(403);
    const res = await ana.post(`/workspaces/${wsId}/collections/${c.id}/versions/1/restore`);
    expect(res.body.version).toBe(3);
    expect((await ana.get(`/workspaces/${wsId}`)).body.collections[0].collection.items[1].url).toBe("/items");
    expect((await ana.get(`/workspaces/${wsId}/collections/${c.id}/versions`)).body.versions).toHaveLength(3);
  });
});

describe("trash", () => {
  it("keeps deleted requests, collections and environments restorable", async () => {
    const { ana, bob, viewer, wsId, c, login } = await team();
    // Delete a request by saving without it.
    await bob.put(`/workspaces/${wsId}/collections/${c.id}`, { collection: { ...c, items: c.items.slice(1) }, baseVersion: 1 });
    const env = { id: crypto.randomUUID(), name: "Prod", variables: [] };
    await ana.put(`/workspaces/${wsId}/environments/${env.id}`, { environment: env, baseVersion: 0 });
    await ana.del(`/workspaces/${wsId}/environments/${env.id}`);

    let trash = (await viewer.get(`/workspaces/${wsId}/trash`)).body;
    expect(trash.retentionDays).toBe(30);
    expect(trash.items.map((t: { kind: string; name: string; deletedBy: string }) => `${t.kind}:${t.name}:${t.deletedBy}`)).toEqual(["environment:Prod:Ana", "request:Login:Bob"]);

    const loginEntry = trash.items.find((t: { name: string }) => t.name === "Login");
    expect((await viewer.post(`/workspaces/${wsId}/trash/${loginEntry.id}/restore`)).status).toBe(403);
    expect((await bob.post(`/workspaces/${wsId}/trash/${loginEntry.id}/restore`)).status).toBe(200);
    const items = (await ana.get(`/workspaces/${wsId}`)).body.collections[0].collection.items;
    expect(items.map((i: { id: string }) => i.id)).toContain(login.id);

    const envEntry = trash.items.find((t: { name: string }) => t.name === "Prod");
    await ana.post(`/workspaces/${wsId}/trash/${envEntry.id}/restore`);
    expect((await ana.get(`/workspaces/${wsId}`)).body.environments[0].environment.name).toBe("Prod");

    // Whole collection.
    await ana.del(`/workspaces/${wsId}/collections/${c.id}`);
    trash = (await ana.get(`/workspaces/${wsId}/trash`)).body;
    const colEntry = trash.items.find((t: { kind: string }) => t.kind === "collection");
    await ana.post(`/workspaces/${wsId}/trash/${colEntry.id}/restore`);
    const restored = (await ana.get(`/workspaces/${wsId}`)).body.collections[0];
    expect(restored.collection.name).toBe("API");
    expect(restored.version).toBeGreaterThan(2); // history continues
    expect((await ana.get(`/workspaces/${wsId}/trash`)).body.items).toEqual([]);
  });

  it("expires after 30 days and admins can purge", async () => {
    const { ana, bob, wsId, c } = await team();
    await ana.del(`/workspaces/${wsId}/collections/${c.id}`);
    const [entry] = (await ana.get(`/workspaces/${wsId}/trash`)).body.items;
    expect((await bob.del(`/workspaces/${wsId}/trash/${entry.id}`)).status).toBe(403);
    await ctx.sql`update trash set deleted_at = now() - interval '31 days'`;
    expect((await ana.get(`/workspaces/${wsId}/trash`)).body.items).toEqual([]);
  });
});
