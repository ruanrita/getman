/**
 * Saving, deleting and restoring collections / environments with history,
 * three-way merge and trash. Used by the sync routes and the history routes.
 */
import { sanitizeVariables, type Collection, type Environment, type Item, type Variable } from "@getman/core";
import type postgres from "postgres";
import type { Sql } from "./db";

/** A connection or an open transaction. */
type Tx = Sql | postgres.TransactionSql;
import { conflict, notFound } from "./errors";
import { mergeCollection, mergeEnvironment, removedItems, type MergeConflict } from "./merge";
import type { Hub } from "./realtime";

export type ContentKind = "collection" | "environment";
type Data = Collection | Environment;

/** Versions kept per collection / environment; older ones are pruned. */
export const HISTORY_LIMIT = 200;
/** Days items stay in the trash. */
export const TRASH_DAYS = 30;

const TABLES = {
  collection: { table: "collections", history: "collection_versions", ref: "collection_id" },
  environment: { table: "environments", history: "environment_versions", ref: "environment_id" },
} as const;

const clean = <T extends Data>(data: T): T => ({ ...data, variables: sanitizeVariables(data.variables as Variable[]) });

function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v,
  );
}

export interface SaveResult {
  version: number;
  /** The stored copy when it differs from what was sent (merged with others' changes). */
  merged?: Data;
  conflicts: MergeConflict[];
}

export function contentStore(sql: Sql, hub: Hub) {
  /** Writes one version: current row, history row, trash for removed items, pruning, live event. */
  async function write(tx: Tx, kind: ContentKind, wsId: string, userId: string, data: Data, previous: Data | undefined, version: number) {
    const t = TABLES[kind];
    await tx.unsafe(
      `insert into ${t.table} (workspace_id, id, data, version, updated_by) values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, id) do update set data = excluded.data, version = excluded.version, updated_at = now(), updated_by = excluded.updated_by`,
      [wsId, data.id, data as never, version, userId],
    );
    await tx.unsafe(`insert into ${t.history} (workspace_id, ${t.ref}, version, data, saved_by) values ($1, $2, $3, $4, $5) on conflict do nothing`, [
      wsId,
      data.id,
      version,
      data as never,
      userId,
    ]);
    await tx.unsafe(
      `delete from ${t.history} where workspace_id = $1 and ${t.ref} = $2 and version <= $3`,
      [wsId, data.id, version - HISTORY_LIMIT],
    );
    if (kind === "collection" && previous) {
      for (const { item, parent } of removedItems((previous as Collection).items, (data as Collection).items)) {
        await trash(tx, wsId, userId, item.kind, item.id, item.name, item, data.id, parent);
      }
    }
  }

  async function trash(tx: Tx, wsId: string, userId: string, kind: string, itemId: string, name: string, data: unknown, collectionId: string | null, parentId: string | null) {
    await tx`
      insert into trash (workspace_id, kind, item_id, name, data, collection_id, parent_id, deleted_by)
      values (${wsId}, ${kind}, ${itemId}, ${name}, ${tx.json(data as never)}, ${collectionId}, ${parentId}, ${userId})`;
  }

  const publish = (kind: ContentKind, wsId: string, data: Data, version: number, by: string) =>
    hub.publish(
      kind === "collection"
        ? { type: "collection.put", workspaceId: wsId, collection: data, version, by }
        : { type: "environment.put", workspaceId: wsId, environment: data, version, by },
    );

  return {
    /**
     * Saves `incoming`, which was edited starting from `baseVersion` (0 = new).
     * If others saved meanwhile, merges per request/variable; conflicting items
     * keep the server copy and are reported back.
     */
    async save(kind: ContentKind, wsId: string, userId: string, incoming: Data, baseVersion: number): Promise<SaveResult> {
      const t = TABLES[kind];
      const data = clean(incoming);
      const result = await sql.begin(async (tx) => {
        const [current] = await tx.unsafe<{ data: Data; version: number }[]>(
          `select data, version from ${t.table} where workspace_id = $1 and id = $2 for update`,
          [wsId, data.id],
        );
        if (!current) {
          if (baseVersion !== 0) {
            // Deleted by someone else while this was being edited: saving brings it back.
            const [last] = await tx.unsafe<{ v: number | null }[]>(`select max(version) as v from ${t.history} where workspace_id = $1 and ${t.ref} = $2`, [wsId, data.id]);
            const version = (last?.v ?? 0) + 1;
            await write(tx, kind, wsId, userId, data, undefined, version);
            return { version, conflicts: [], created: true, wrote: true };
          }
          await write(tx, kind, wsId, userId, data, undefined, 1);
          return { version: 1, conflicts: [], created: true, wrote: true };
        }
        if (baseVersion === current.version) {
          await write(tx, kind, wsId, userId, data, current.data, current.version + 1);
          return { version: current.version + 1, conflicts: [], wrote: true };
        }
        if (baseVersion === 0) throw conflict(`A ${kind} with this id already exists`, "version_conflict", { [kind]: current.data, version: current.version });

        const [base] = await tx.unsafe<{ data: Data }[]>(`select data from ${t.history} where workspace_id = $1 and ${t.ref} = $2 and version = $3`, [
          wsId,
          data.id,
          baseVersion,
        ]);
        if (!base) throw conflict(`Your copy of this ${kind} is too old to merge. Reload it and redo the change.`, "version_conflict", { [kind]: current.data, version: current.version });

        const { merged, conflicts } =
          kind === "collection"
            ? mergeCollection(base.data as Collection, data as Collection, current.data as Collection)
            : mergeEnvironment(base.data as Environment, data as Environment, current.data as Environment);
        if (stable(merged) === stable(current.data)) return { version: current.version, merged: current.data, conflicts, wrote: false };
        await write(tx, kind, wsId, userId, merged, current.data, current.version + 1);
        return { version: current.version + 1, merged, conflicts, wrote: true };
      });

      if ("created" in result && kind === "collection") {
        await sql`insert into audit_log (workspace_id, actor_id, action, details) values (${wsId}, ${userId}, 'collection.created', ${sql.json({ name: data.name } as never)})`;
      }
      const stored = result.merged ?? data;
      if (result.wrote) publish(kind, wsId, stored, result.version, userId);
      return {
        version: result.version,
        ...(result.merged && stable(result.merged) !== stable(data) ? { merged: result.merged } : {}),
        conflicts: result.conflicts,
      };
    },

    /** Deletes a collection / environment into the trash. */
    async remove(kind: ContentKind, wsId: string, userId: string, id: string) {
      const t = TABLES[kind];
      const [row] = await sql.unsafe<{ data: Data }[]>(`delete from ${t.table} where workspace_id = $1 and id = $2 returning data`, [wsId, id]);
      if (!row) throw notFound(`${kind === "collection" ? "Collection" : "Environment"} not found`);
      await trash(sql, wsId, userId, kind, id, row.data.name, row.data, null, null);
      await sql`insert into audit_log (workspace_id, actor_id, action, details) values (${wsId}, ${userId}, ${`${kind}.deleted`}, ${sql.json({ name: row.data.name } as never)})`;
      hub.publish(kind === "collection" ? { type: "collection.deleted", workspaceId: wsId, id, by: userId } : { type: "environment.deleted", workspaceId: wsId, id, by: userId });
      return row.data;
    },

    /** Saves `data` as the newest version regardless of what is there (restore). */
    async overwrite(kind: ContentKind, wsId: string, userId: string, data: Data) {
      const t = TABLES[kind];
      const [current] = await sql.unsafe<{ version: number }[]>(`select version from ${t.table} where workspace_id = $1 and id = $2`, [wsId, data.id]);
      const [last] = await sql.unsafe<{ v: number | null }[]>(`select max(version) as v from ${t.history} where workspace_id = $1 and ${t.ref} = $2`, [wsId, data.id]);
      return this.save(kind, wsId, userId, data, current?.version ?? last?.v ?? 0);
    },

    async insertItem(wsId: string, userId: string, collectionId: string, item: Item, parentId: string | null) {
      const [row] = await sql<{ data: Collection; version: number }[]>`select data, version from collections where workspace_id = ${wsId} and id = ${collectionId}`;
      if (!row) throw notFound("Its collection no longer exists. Restore the collection first.");
      const insert = (items: Item[]): { items: Item[]; done: boolean } => {
        if (!parentId) return { items: [...items, item], done: true };
        let done = false;
        const next = items.map((i) => {
          if (i.kind !== "folder") return i;
          if (i.id === parentId) {
            done = true;
            return { ...i, items: [...i.items, item] };
          }
          const sub = insert(i.items);
          done ||= sub.done;
          return { ...i, items: sub.items };
        });
        return { items: next, done };
      };
      let { items, done } = insert(row.data.items);
      if (!done) items = [...row.data.items, item]; // parent folder gone: put it at the root
      return this.save("collection", wsId, userId, { ...row.data, items }, row.version);
    },

  };
}

export type ContentStore = ReturnType<typeof contentStore>;
