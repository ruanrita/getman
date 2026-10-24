import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Action } from "@getman/core";
import { z } from "zod";
import { requireAuth } from "../auth";
import { driverFor, restoreBackup, runBackup, type TargetRow } from "../backup/service";
import { createDriver, targetSchemas, testDriver, type TargetKind } from "../backup/targets";
import type { Config } from "../config";
import { decrypt, encrypt } from "../crypto";
import type { Sql } from "../db";
import { badRequest, notFound } from "../errors";

type Access = (req: FastifyRequest, workspaceId: string, action: Action) => Promise<{ id: string; name: string }>;

const schedule = z.enum(["manual", "hourly", "daily", "weekly"]);
const passphrase = z.string().min(12, "Backup passphrase must have at least 12 characters").max(256);

const targetBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("s3"), config: targetSchemas.s3.config, secrets: targetSchemas.s3.secrets }),
  z.object({ kind: z.literal("local"), config: targetSchemas.local.config, secrets: targetSchemas.local.secrets }),
  z.object({ kind: z.literal("postgres"), config: targetSchemas.postgres.config, secrets: targetSchemas.postgres.secrets }),
]);

const publicTarget = `
  id, name, kind, config, schedule, retention, enabled,
  last_run_at as "lastRunAt", last_status as "lastStatus", last_error as "lastError", created_at as "createdAt"`;

/** Turns driver errors (S3 SDK, fs, pg) into a readable 400 for the setup form. */
async function verify(kind: TargetKind, config: unknown, secrets: unknown, cfg: Config) {
  const driver = await createDriver(kind, config, secrets, cfg);
  try {
    await testDriver(driver);
  } catch (e) {
    throw badRequest(`Could not write to this target: ${(e as Error).message}`, "target_unreachable");
  }
}

export function backupRoutes(app: FastifyInstance, sql: Sql, config: Config, access: Access) {
  const auth = { preHandler: requireAuth(sql, config) };

  async function loadTarget(req: FastifyRequest, workspaceId: string, targetId: string) {
    const ws = await access(req, workspaceId, "backup.manage");
    const [t] = await sql<TargetRow[]>`select * from backup_targets where id = ${targetId} and workspace_id = ${ws.id}`;
    if (!t) throw notFound("Backup target not found");
    return t;
  }

  async function audit(workspaceId: string, actorId: string, action: string, details: Record<string, unknown>) {
    await sql`insert into audit_log (workspace_id, actor_id, action, details) values (${workspaceId}, ${actorId}, ${action}, ${sql.json(details as never)})`;
  }

  app.get<{ Params: { id: string } }>("/workspaces/:id/backup-targets", auth, async (req) => {
    const ws = await access(req, req.params.id, "backup.manage");
    const targets = await sql.unsafe(`select ${publicTarget} from backup_targets where workspace_id = $1 order by created_at`, [ws.id]);
    const runs = await sql`
      select id, target_id as "targetId", status, trigger, object_key as "objectKey", size_bytes as "sizeBytes", error,
             started_at as "startedAt", finished_at as "finishedAt"
      from backup_runs where workspace_id = ${ws.id} order by started_at desc limit 50`;
    return { targets, runs, localBackupsEnabled: Boolean(config.backupDir) };
  });

  /** Checks a configuration without saving it. */
  app.post<{ Params: { id: string } }>("/workspaces/:id/backup-targets/test", auth, async (req) => {
    await access(req, req.params.id, "backup.manage");
    const body = targetBody.parse(req.body);
    await verify(body.kind, body.config, body.secrets, config);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/workspaces/:id/backup-targets", auth, async (req) => {
    const ws = await access(req, req.params.id, "backup.manage");
    const body = targetBody.and(
      z.object({ name: z.string().trim().min(1).max(100), schedule: schedule.default("daily"), retention: z.number().int().min(1).max(1000).default(14), passphrase }),
    ).parse(req.body);
    await verify(body.kind, body.config, body.secrets, config);
    const [t] = await sql.unsafe(
      `insert into backup_targets (workspace_id, name, kind, config, secrets_enc, passphrase_enc, schedule, retention, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${publicTarget}`,
      [
        ws.id,
        body.name,
        body.kind,
        body.config as never,
        Object.keys(body.secrets).length ? encrypt(config.encryptionKey, JSON.stringify(body.secrets)) : null,
        encrypt(config.encryptionKey, body.passphrase),
        body.schedule,
        body.retention,
        req.user!.id,
      ],
    );
    await audit(ws.id, req.user!.id, "backup.target_created", { name: body.name, kind: body.kind, schedule: body.schedule });
    return { target: t };
  });

  app.patch<{ Params: { id: string; tid: string } }>("/workspaces/:id/backup-targets/:tid", auth, async (req) => {
    const t = await loadTarget(req, req.params.id, req.params.tid);
    const body = z
      .object({ name: z.string().trim().min(1).max(100), schedule, retention: z.number().int().min(1).max(1000), enabled: z.boolean() })
      .partial()
      .parse(req.body);
    const [updated] = await sql.unsafe(
      `update backup_targets set name = coalesce($2, name), schedule = coalesce($3, schedule), retention = coalesce($4, retention),
       enabled = coalesce($5, enabled) where id = $1 returning ${publicTarget}`,
      [t.id, body.name ?? null, body.schedule ?? null, body.retention ?? null, body.enabled ?? null],
    );
    await audit(t.workspace_id, req.user!.id, "backup.target_updated", { name: t.name, ...body });
    return { target: updated };
  });

  /** Deletes the target configuration. Backup files already written are kept. */
  app.delete<{ Params: { id: string; tid: string } }>("/workspaces/:id/backup-targets/:tid", auth, async (req) => {
    const t = await loadTarget(req, req.params.id, req.params.tid);
    await sql`delete from backup_targets where id = ${t.id}`;
    await audit(t.workspace_id, req.user!.id, "backup.target_deleted", { name: t.name });
    return { ok: true };
  });

  app.post<{ Params: { id: string; tid: string } }>("/workspaces/:id/backup-targets/:tid/run", auth, async (req) => {
    const t = await loadTarget(req, req.params.id, req.params.tid);
    const run = await runBackup(sql, config, t, "manual", req.log);
    if (!run) throw badRequest("A backup for this target is already running", "backup_running");
    return { run };
  });

  async function loadRun(req: FastifyRequest, workspaceId: string, runId: string) {
    if (!z.string().uuid().safeParse(runId).success) throw notFound("Backup not found");
    const ws = await access(req, workspaceId, "backup.manage");
    const [run] = await sql<{ object_key: string | null; target_id: string; status: string }[]>`
      select object_key, target_id, status from backup_runs where id = ${runId} and workspace_id = ${ws.id}`;
    if (!run?.object_key || run.status !== "ok") throw notFound("Backup not found");
    const [target] = await sql<TargetRow[]>`select * from backup_targets where id = ${run.target_id}`;
    return { run, target: target!, workspace: ws };
  }

  app.get<{ Params: { id: string; rid: string } }>("/workspaces/:id/backup-runs/:rid/download", auth, async (req, reply) => {
    const { run, target } = await loadRun(req, req.params.id, req.params.rid);
    const file = await (await driverFor(target, config)).get(run.object_key!);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${run.object_key}"`)
      .send(file);
  });

  /** Restores a stored backup into a new workspace, using the target's passphrase. */
  app.post<{ Params: { id: string; rid: string } }>("/workspaces/:id/backup-runs/:rid/restore", auth, async (req) => {
    const { run, target, workspace } = await loadRun(req, req.params.id, req.params.rid);
    const body = z.object({ name: z.string().max(100).optional(), restoreMembers: z.boolean().default(false) }).parse(req.body ?? {});
    const file = await (await driverFor(target, config)).get(run.object_key!);
    const result = await restoreBackup(sql, file, decrypt(config.encryptionKey, target.passphrase_enc), req.user!.id, body);
    await audit(workspace.id, req.user!.id, "backup.restored", { into: result.name, backup: run.object_key });
    return result;
  });

  /** Disaster recovery: restore a downloaded backup file (workspace may no longer exist). */
  app.post("/restore", { ...auth, bodyLimit: 70 * 1024 * 1024 }, async (req) => {
    const body = z
      .object({ file: z.string().min(1), passphrase: z.string().min(1).max(256), name: z.string().max(100).optional(), restoreMembers: z.boolean().default(false) })
      .parse(req.body);
    return restoreBackup(sql, Buffer.from(body.file, "base64"), body.passphrase, req.user!.id, body);
  });
}
