import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Action, Collection, Environment, Item } from "@getman/core";
import { z } from "zod";
import { requireAuth } from "../auth";
import type { Config } from "../config";
import { TRASH_DAYS, type ContentStore } from "../content";
import type { Sql } from "../db";
import { badRequest, notFound } from "../errors";

type Access = (req: FastifyRequest, workspaceId: string, action: Action) => Promise<{ id: string }>;

const uuid = z.string().uuid();

function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

function findItem(items: Item[], id: string): Item | undefined {
  for (const i of items) {
    if (i.id === id) return i;
    if (i.kind === "folder") {
      const found = findItem(i.items, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Fields of a request/folder that count as "its content" (children excluded). */
const own = (i: Item | undefined) => (i ? (i.kind === "folder" ? { ...i, items: undefined } : i) : undefined);

/** Version history (server workspaces) and the trash. */
export function historyRoutes(app: FastifyInstance, sql: Sql, config: Config, access: Access, content: ContentStore) {
  const auth = { preHandler: requireAuth(sql, config) };

  /* ---------- collection history ---------- */

  app.get<{ Params: { id: string; cid: string } }>("/workspaces/:id/collections/:cid/versions", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const rows = await sql<{ version: number; data: Collection; savedAt: Date; savedBy: string | null }[]>`
      select v.version, v.data, v.saved_at as "savedAt", u.name as "savedBy"
      from collection_versions v left join users u on u.id = v.saved_by
      where v.workspace_id = ${ws.id} and v.collection_id = ${uuid.parse(req.params.cid)}
      order by v.version`;
    // Summarise each version against the previous one: which requests/folders changed.
    const versions = rows.map((r, idx) => {
      const prev = rows[idx - 1]?.data;
      const flat = (c?: Collection) => {
        const map = new Map<string, Item>();
        const walk = (items: Item[]) => items.forEach((i) => (map.set(i.id, i), i.kind === "folder" && walk(i.items)));
        walk(c?.items ?? []);
        return map;
      };
      const before = flat(prev);
      const after = flat(r.data);
      const changes: { id: string; name: string; change: "added" | "changed" | "deleted" }[] = [];
      for (const [id, item] of after) {
        if (!before.has(id)) changes.push({ id, name: item.name, change: "added" });
        else if (stable(own(item)) !== stable(own(before.get(id)))) changes.push({ id, name: item.name, change: "changed" });
      }
      for (const [id, item] of before) if (!after.has(id)) changes.push({ id, name: item.name, change: "deleted" });
      const { items: _a, ...settingsNow } = r.data;
      const settingsBefore = prev ? (({ items: _b, ...s }) => s)(prev) : undefined;
      const settingsChanged = Boolean(prev) && stable(settingsNow) !== stable(settingsBefore);
      return { version: r.version, savedAt: r.savedAt, savedBy: r.savedBy, name: r.data.name, changes, settingsChanged };
    });
    return { versions: versions.reverse() };
  });

  app.get<{ Params: { id: string; cid: string; v: string } }>("/workspaces/:id/collections/:cid/versions/:v", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const [row] = await sql<{ data: Collection }[]>`
      select data from collection_versions where workspace_id = ${ws.id} and collection_id = ${uuid.parse(req.params.cid)} and version = ${Number(req.params.v)}`;
    if (!row) throw notFound("Version not found");
    return { collection: row.data };
  });

  /** Makes an old version the newest one (a new version; nothing is lost). */
  app.post<{ Params: { id: string; cid: string; v: string } }>("/workspaces/:id/collections/:cid/versions/:v/restore", auth, async (req) => {
    const ws = await access(req, req.params.id, "collections.write");
    const [row] = await sql<{ data: Collection }[]>`
      select data from collection_versions where workspace_id = ${ws.id} and collection_id = ${uuid.parse(req.params.cid)} and version = ${Number(req.params.v)}`;
    if (!row) throw notFound("Version not found");
    const result = await content.overwrite("collection", ws.id, req.user!.id, row.data);
    await sql`insert into audit_log (workspace_id, actor_id, action, details)
      values (${ws.id}, ${req.user!.id}, 'collection.version_restored', ${sql.json({ name: row.data.name, version: Number(req.params.v) } as never)})`;
    return result;
  });

  /** Versions in which one request or folder changed, newest first, with its content at that point. */
  app.get<{ Params: { id: string; cid: string; itemId: string } }>("/workspaces/:id/collections/:cid/items/:itemId/history", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const rows = await sql<{ version: number; data: Collection; savedAt: Date; savedBy: string | null }[]>`
      select v.version, v.data, v.saved_at as "savedAt", u.name as "savedBy"
      from collection_versions v left join users u on u.id = v.saved_by
      where v.workspace_id = ${ws.id} and v.collection_id = ${uuid.parse(req.params.cid)}
      order by v.version`;
    const out: { version: number; savedAt: Date; savedBy: string | null; change: "created" | "changed" | "deleted"; item: Item | null }[] = [];
    let last: string | undefined;
    for (const r of rows) {
      const item = findItem(r.data.items, req.params.itemId);
      const fp = item ? stable(own(item)) : undefined;
      if (fp === last) continue;
      out.push({ version: r.version, savedAt: r.savedAt, savedBy: r.savedBy, change: !item ? "deleted" : last === undefined ? "created" : "changed", item: item ?? null });
      last = fp;
    }
    return { history: out.reverse() };
  });

  /* ---------- environment history ---------- */

  app.get<{ Params: { id: string; eid: string } }>("/workspaces/:id/environments/:eid/versions", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    const versions = await sql`
      select v.version, v.data, v.saved_at as "savedAt", u.name as "savedBy"
      from environment_versions v left join users u on u.id = v.saved_by
      where v.workspace_id = ${ws.id} and v.environment_id = ${uuid.parse(req.params.eid)}
      order by v.version desc`;
    return { versions };
  });

  /* ---------- trash ---------- */

  const purge = (wsId: string) => sql`delete from trash where workspace_id = ${wsId} and deleted_at < now() - make_interval(days => ${TRASH_DAYS})`;

  app.get<{ Params: { id: string } }>("/workspaces/:id/trash", auth, async (req) => {
    const ws = await access(req, req.params.id, "workspace.read");
    await purge(ws.id);
    const items = await sql`
      select t.id, t.kind, t.name, t.collection_id as "collectionId", t.deleted_at as "deletedAt", u.name as "deletedBy",
        (select c.data->>'name' from collections c where c.workspace_id = t.workspace_id and c.id = t.collection_id) as "collectionName",
        t.deleted_at + make_interval(days => ${TRASH_DAYS}) as "expiresAt"
      from trash t left join users u on u.id = t.deleted_by
      where t.workspace_id = ${ws.id} order by t.deleted_at desc limit 500`;
    return { items, retentionDays: TRASH_DAYS };
  });

  app.post<{ Params: { id: string; tid: string } }>("/workspaces/:id/trash/:tid/restore", auth, async (req) => {
    const [entry] = await sql<{ id: string; workspace_id: string; kind: string; name: string; data: unknown; collection_id: string | null; parent_id: string | null }[]>`
      select * from trash where id = ${uuid.parse(req.params.tid)}`;
    if (!entry) throw notFound("Not in the trash (it may have expired)");
    const ws = await access(req, req.params.id, entry.kind === "environment" ? "environments.write" : "collections.write");
    if (entry.workspace_id !== ws.id) throw notFound("Not in the trash");

    if (entry.kind === "collection" || entry.kind === "environment") {
      const table = entry.kind === "collection" ? "collections" : "environments";
      const [exists] = await sql.unsafe(`select 1 from ${table} where workspace_id = $1 and id = $2`, [ws.id, (entry.data as { id: string }).id]);
      if (exists) throw badRequest(`This ${entry.kind} already exists again; nothing to restore.`, "already_restored");
      await content.overwrite(entry.kind, ws.id, req.user!.id, entry.data as Collection | Environment);
    } else {
      await content.insertItem(ws.id, req.user!.id, entry.collection_id!, entry.data as Item, entry.parent_id);
    }
    await sql`delete from trash where id = ${entry.id}`;
    await sql`insert into audit_log (workspace_id, actor_id, action, details)
      values (${ws.id}, ${req.user!.id}, 'trash.restored', ${sql.json({ kind: entry.kind, name: entry.name } as never)})`;
    return { ok: true };
  });

  /** Permanently deletes one entry (admins). */
  app.delete<{ Params: { id: string; tid: string } }>("/workspaces/:id/trash/:tid", auth, async (req) => {
    const ws = await access(req, req.params.id, "members.manage");
    const [row] = await sql`delete from trash where id = ${uuid.parse(req.params.tid)} and workspace_id = ${ws.id} returning id`;
    if (!row) throw notFound("Not in the trash");
    return { ok: true };
  });
}
