import type { FastifyBaseLogger } from "fastify";
import type { Collection, Environment, Role, Variable } from "@getman/core";
import type { Config } from "../config";
import { decrypt } from "../crypto";
import type { Sql } from "../db";
import { notFound } from "../errors";
import { openBackup, sealBackup, type BackupPayload } from "./format";
import { createDriver, type TargetKind } from "./targets";

export interface TargetRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: TargetKind;
  config: unknown;
  secrets_enc: string | null;
  passphrase_enc: string;
  schedule: "manual" | "hourly" | "daily" | "weekly";
  retention: number;
  enabled: boolean;
}

const INTERVAL: Record<Exclude<TargetRow["schedule"], "manual">, string> = { hourly: "1 hour", daily: "1 day", weekly: "7 days" };

export function driverFor(target: TargetRow, config: Config) {
  const secrets = target.secrets_enc ? JSON.parse(decrypt(config.encryptionKey, target.secrets_enc)) : {};
  return createDriver(target.kind, target.config, secrets, config);
}

/** Everything needed to recreate the workspace. Content is already sanitized in the database. */
export async function buildPayload(sql: Sql, workspaceId: string): Promise<BackupPayload> {
  const [ws] = await sql<{ id: string; name: string; require_2fa: boolean; globals: Variable[] }[]>`
    select id, name, require_2fa, globals from workspaces where id = ${workspaceId}`;
  if (!ws) throw notFound("Workspace not found");
  const members = await sql<{ email: string; role: Role }[]>`
    select u.email, m.role from members m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId}`;
  const collections = await sql<{ data: Collection }[]>`select data from collections where workspace_id = ${workspaceId}`;
  const environments = await sql<{ data: Environment }[]>`select data from environments where workspace_id = ${workspaceId}`;
  return {
    getmanBackup: 1,
    createdAt: new Date().toISOString(),
    workspace: { id: ws.id, name: ws.name, require2fa: ws.require_2fa },
    members: members.map((m) => ({ email: m.email, role: m.role })),
    globals: ws.globals,
    collections: collections.map((c) => c.data),
    environments: environments.map((e) => e.data),
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";

const running = new Set<string>();

/** Runs one backup and applies retention. Never throws: the outcome is recorded on the run. */
export async function runBackup(sql: Sql, config: Config, target: TargetRow, trigger: "manual" | "schedule", log?: FastifyBaseLogger) {
  if (running.has(target.id)) return undefined;
  running.add(target.id);
  const [run] = await sql<{ id: string }[]>`
    insert into backup_runs (target_id, workspace_id, status, trigger) values (${target.id}, ${target.workspace_id}, 'running', ${trigger}) returning id`;
  try {
    const payload = await buildPayload(sql, target.workspace_id);
    const file = await sealBackup(payload, decrypt(config.encryptionKey, target.passphrase_enc));
    const key = `${slug(payload.workspace.name)}-${target.workspace_id.slice(0, 8)}-${payload.createdAt.replace(/[:.]/g, "-")}.getman-backup`;
    const driver = await driverFor(target, config);
    await driver.put(key, file);
    await sql`update backup_runs set status = 'ok', object_key = ${key}, size_bytes = ${file.length}, finished_at = now() where id = ${run!.id}`;
    await sql`update backup_targets set last_run_at = now(), last_status = 'ok', last_error = null where id = ${target.id}`;

    // Retention: keep the newest N successful backups.
    const old = await sql<{ id: string; object_key: string }[]>`
      select id, object_key from backup_runs where target_id = ${target.id} and status = 'ok'
      order by started_at desc offset ${target.retention}`;
    for (const r of old) {
      try {
        await driver.remove(r.object_key);
        await sql`delete from backup_runs where id = ${r.id}`;
      } catch (e) {
        log?.warn({ err: e, run: r.id }, "backup retention: could not delete old backup");
      }
    }
  } catch (e) {
    const message = (e as Error).message?.slice(0, 1000) || String(e);
    await sql`update backup_runs set status = 'error', error = ${message}, finished_at = now() where id = ${run!.id}`;
    await sql`update backup_targets set last_run_at = now(), last_status = 'error', last_error = ${message} where id = ${target.id}`;
    log?.error({ err: e, target: target.id }, "backup failed");
  } finally {
    running.delete(target.id);
  }
  const [result] = await sql`
    select id, status, trigger, object_key as "objectKey", size_bytes as "sizeBytes", error, started_at as "startedAt", finished_at as "finishedAt"
    from backup_runs where id = ${run!.id}`;
  return result;
}

/** Runs every enabled scheduled target whose interval has elapsed. Returns how many ran. */
export async function runDueBackups(sql: Sql, config: Config, log?: FastifyBaseLogger): Promise<number> {
  let count = 0;
  for (const [schedule, interval] of Object.entries(INTERVAL)) {
    const due = await sql<TargetRow[]>`
      select * from backup_targets
      where enabled and schedule = ${schedule}
        and (last_run_at is null or last_run_at <= now() - ${interval}::interval)`;
    for (const t of due) if (await runBackup(sql, config, t, "schedule", log)) count++;
  }
  return count;
}

/** Checks every minute for scheduled targets that are due. Single-instance (see docs). */
export function startScheduler(sql: Sql, config: Config, log: FastifyBaseLogger): () => void {
  const timer = setInterval(() => void runDueBackups(sql, config, log).catch((e) => log.error({ err: e }, "backup scheduler")), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Creates a new workspace owned by `ownerId` from a backup. Never overwrites
 * the original. Optionally re-adds members that still have accounts here.
 */
export async function restoreBackup(sql: Sql, file: Buffer, passphrase: string, ownerId: string, opts: { name?: string; restoreMembers?: boolean }) {
  const payload = await openBackup(file, passphrase);
  const name = opts.name?.trim() || `${payload.workspace.name} (restored)`;
  const id = await sql.begin(async (tx) => {
    const [ws] = await tx<{ id: string }[]>`
      insert into workspaces (name, globals, require_2fa) values (${name}, ${tx.json(payload.globals as never)}, ${payload.workspace.require2fa}) returning id`;
    await tx`insert into members (workspace_id, user_id, role) values (${ws!.id}, ${ownerId}, 'owner')`;
    for (const c of payload.collections) {
      await tx`insert into collections (workspace_id, id, data, updated_by) values (${ws!.id}, ${c.id}, ${tx.json(c as never)}, ${ownerId})`;
    }
    for (const e of payload.environments) {
      await tx`insert into environments (workspace_id, id, data, updated_by) values (${ws!.id}, ${e.id}, ${tx.json(e as never)}, ${ownerId})`;
    }
    if (opts.restoreMembers) {
      for (const m of payload.members) {
        const role = m.role === "owner" ? "admin" : m.role; // the restorer is the new owner
        await tx`
          insert into members (workspace_id, user_id, role)
          select ${ws!.id}, id, ${role} from users where email = ${m.email} and id <> ${ownerId}
          on conflict do nothing`;
      }
    }
    await tx`
      insert into audit_log (workspace_id, actor_id, action, details)
      values (${ws!.id}, ${ownerId}, 'workspace.restored', ${tx.json({ from: payload.workspace.name, backupCreatedAt: payload.createdAt } as never)})`;
    return ws!.id;
  });
  return { id, name, collections: payload.collections.length, environments: payload.environments.length };
}
