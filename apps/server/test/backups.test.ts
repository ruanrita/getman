import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openBackup } from "../src/backup/format";
import { runDueBackups } from "../src/backup/service";
import { isPrivateAddress } from "../src/net";
import { collection, config, reset, setup, signUp, TEST_DB } from "./helpers";

const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? "http://localhost:58333";
const BUCKET = "getman-test";
const PASSPHRASE = "a long backup passphrase";

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
  const s3 = new S3Client({ endpoint: S3_ENDPOINT, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId: "x", secretAccessKey: "x" } });
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => {}); // already exists
});
afterAll(async () => {
  await ctx.app.close();
  await ctx.sql.end();
});
beforeEach(() => reset(ctx.sql));

const s3Target = (extra: Record<string, unknown> = {}) => ({
  name: "Nightly S3",
  kind: "s3",
  config: { endpoint: S3_ENDPOINT, bucket: BUCKET, prefix: `t${Date.now()}/` },
  secrets: { accessKeyId: "getman", secretAccessKey: "getman-secret" },
  schedule: "daily",
  retention: 5,
  passphrase: PASSPHRASE,
  ...extra,
});

async function workspaceWithContent() {
  const owner = await signUp(ctx.app, "owner@example.com");
  const editor = await signUp(ctx.app, "editor@example.com");
  const ws = (await owner.post("/workspaces", { name: "Payments API" })).body;
  await owner.post(`/workspaces/${ws.id}/members`, { email: "editor@example.com", role: "editor" });
  const c = collection("Orders", { variables: [{ id: "1", key: "token", value: "do-not-leak", enabled: true, secret: true }] });
  await owner.put(`/workspaces/${ws.id}/collections/${c.id}`, { collection: c, baseVersion: 0 });
  return { owner, editor, wsId: ws.id as string, collectionId: c.id };
}

describe("backup targets", () => {
  it("tests the connection, never returns secrets, and is admin-only", async () => {
    const { owner, editor, wsId } = await workspaceWithContent();
    const bad = await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target({ config: { endpoint: "http://localhost:1", bucket: BUCKET } }));
    expect(bad.body.error.code).toBe("target_unreachable");

    const created = await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target());
    expect(created.status).toBe(200);
    const listed = await owner.get(`/workspaces/${wsId}/backup-targets`);
    expect(JSON.stringify(listed.body)).not.toMatch(/getman-secret|backup passphrase|secrets_enc|passphrase_enc/);
    expect(listed.body.targets[0]).toMatchObject({ name: "Nightly S3", kind: "s3", schedule: "daily" });

    expect((await editor.get(`/workspaces/${wsId}/backup-targets`)).status).toBe(403);
    expect((await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target({ passphrase: "short" }))).body.error.code).toBe("validation");
  });

  it("backs up to S3 as an encrypted file without secrets, and restores it", async () => {
    const { owner, editor, wsId, collectionId } = await workspaceWithContent();
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target())).body;
    const { run } = (await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body;
    expect(run).toMatchObject({ status: "ok", trigger: "manual" });
    expect(run.sizeBytes).toBeGreaterThan(49);

    const download = await ctx.app.inject({ method: "GET", url: `/workspaces/${wsId}/backup-runs/${run.id}/download`, headers: { authorization: `Bearer ${owner.token}` } });
    const file = download.rawPayload;
    expect(file.subarray(0, 4).toString()).toBe("GMBK");
    expect(file.toString("latin1")).not.toContain("Orders"); // encrypted
    await expect(openBackup(file, "wrong passphrase!!")).rejects.toThrow(/passphrase/);
    const payload = await openBackup(file, PASSPHRASE);
    expect(payload.collections.map((c) => c.id)).toEqual([collectionId]);
    expect(JSON.stringify(payload)).not.toContain("do-not-leak");
    expect(payload.members.map((m) => m.email).sort()).toEqual(["editor@example.com", "owner@example.com"]);

    const restored = (await owner.post(`/workspaces/${wsId}/backup-runs/${run.id}/restore`, { restoreMembers: true })).body;
    expect(restored).toMatchObject({ name: "Payments API (restored)", collections: 1 });
    const snap = (await owner.get(`/workspaces/${restored.id}`)).body;
    expect(snap.workspace.role).toBe("owner");
    expect(snap.collections[0].collection.name).toBe("Orders");
    expect(snap.members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`).sort()).toEqual(["editor@example.com:editor", "owner@example.com:owner"]);
    expect((await editor.get(`/workspaces/${restored.id}`)).status).toBe(200);
  });

  it("restores a downloaded file into a new workspace, even after the original is deleted", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target())).body;
    const { run } = (await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body;
    const file = (await ctx.app.inject({ method: "GET", url: `/workspaces/${wsId}/backup-runs/${run.id}/download`, headers: { authorization: `Bearer ${owner.token}` } })).rawPayload;
    await owner.del(`/workspaces/${wsId}`);

    const someoneElse = await signUp(ctx.app, "new@example.com");
    expect((await someoneElse.post("/restore", { file: file.toString("base64"), passphrase: "nope nope nope" })).body.error.code).toBe("wrong_passphrase");
    const ok = await someoneElse.post("/restore", { file: file.toString("base64"), passphrase: PASSPHRASE, name: "Recovered" });
    expect(ok.body).toMatchObject({ name: "Recovered", collections: 1 });
    expect((await someoneElse.get("/workspaces")).body.workspaces[0]).toMatchObject({ name: "Recovered", role: "owner" });
    expect((await someoneElse.post("/restore", { file: Buffer.from("hello").toString("base64"), passphrase: PASSPHRASE })).body.error.code).toBe("invalid_backup");
  });

  it("keeps only the newest N backups", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target({ retention: 2 }))).body;
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push((await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body.run);
    const listed = (await owner.get(`/workspaces/${wsId}/backup-targets`)).body.runs;
    expect(listed.map((r: { id: string }) => r.id)).toEqual([runs[2].id, runs[1].id]);
    expect((await owner.get(`/workspaces/${wsId}/backup-runs/${runs[0].id}/download`)).status).toBe(404);
  });

  it("writes to a local folder inside GETMAN_BACKUP_DIR only", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const bad = await owner.post(`/workspaces/${wsId}/backup-targets`, { ...s3Target(), kind: "local", config: { folder: "../../etc" }, secrets: {} });
    expect(bad.body.error.code).toBe("validation");
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, { ...s3Target(), kind: "local", config: { folder: "team/payments" }, secrets: {} })).body;
    const { run } = (await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body;
    expect(run.status).toBe("ok");
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    expect(await readdir(join(config.backupDir!, "team/payments"))).toContain(run.objectKey);
  });

  it("writes to another PostgreSQL database", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const { target } = (
      await owner.post(`/workspaces/${wsId}/backup-targets`, { ...s3Target(), kind: "postgres", config: {}, secrets: { connectionString: TEST_DB } })
    ).body;
    const { run } = (await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body;
    expect(run.status).toBe("ok");
    const [row] = await ctx.sql`select length(data) as size from getman_backups where key = ${run.objectKey}`;
    expect(Number(row!.size)).toBe(run.sizeBytes);
  });

  it("runs scheduled backups when due", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target({ schedule: "daily" }))).body;
    expect(await runDueBackups(ctx.sql, config)).toBe(1); // never ran -> due
    expect(await runDueBackups(ctx.sql, config)).toBe(0); // ran just now
    await ctx.sql`update backup_targets set last_run_at = now() - interval '25 hours' where id = ${target.id}`;
    expect(await runDueBackups(ctx.sql, config)).toBe(1);
    await owner.patch(`/workspaces/${wsId}/backup-targets/${target.id}`, { enabled: false });
    await ctx.sql`update backup_targets set last_run_at = now() - interval '25 hours' where id = ${target.id}`;
    expect(await runDueBackups(ctx.sql, config)).toBe(0);
    const runs = (await owner.get(`/workspaces/${wsId}/backup-targets`)).body.runs;
    expect(runs.every((r: { trigger: string }) => r.trigger === "schedule")).toBe(true);
  });

  it("records failures on the target", async () => {
    const { owner, wsId } = await workspaceWithContent();
    const { target } = (await owner.post(`/workspaces/${wsId}/backup-targets`, s3Target())).body;
    await ctx.sql`update backup_targets set config = jsonb_set(config, '{bucket}', '"missing-bucket-xyz"') where id = ${target.id}`;
    const { run } = (await owner.post(`/workspaces/${wsId}/backup-targets/${target.id}/run`)).body;
    expect(run.status).toBe("error");
    expect((await owner.get(`/workspaces/${wsId}/backup-targets`)).body.targets[0]).toMatchObject({ lastStatus: "error" });
  });
});

describe("private network protection", () => {
  it("classifies addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("blocks private endpoints unless the operator allows them", async () => {
    const strict = await setup({ allowPrivateNetworks: false });
    try {
      const owner = await signUp(strict.app, "strict@example.com");
      const ws = (await owner.post("/workspaces", { name: "W" })).body;
      const res = await owner.post(`/workspaces/${ws.id}/backup-targets/test`, { kind: "s3", config: { endpoint: S3_ENDPOINT, bucket: BUCKET }, secrets: { accessKeyId: "a", secretAccessKey: "b" } });
      expect(res.body.error.code).toBe("private_network");
      const ai = await owner.put(`/workspaces/${ws.id}/ai`, { provider: "openai-compatible", baseUrl: "http://169.254.169.254/v1", model: "m" });
      expect(ai.body.error.code).toBe("private_network");
    } finally {
      await strict.app.close();
      await strict.sql.end();
    }
  });
});
