/**
 * Three-way merge of collections and environments (base = the version the
 * saver started from, ours = what they saved, theirs = what is on the server).
 *
 * Unit of conflict: one request or folder (by id), one collection setting,
 * one variable (by key). Different items edited by different people merge
 * cleanly; only the same item changed differently on both sides is a conflict.
 * On conflict the server copy ("theirs") is kept and the conflict is reported,
 * so the saver's version can go back to them as an unsaved draft.
 */
import type { Collection, Environment, Folder, Item, Variable } from "@getman/core";

export interface MergeConflict {
  kind: "request" | "folder" | "collection" | "environment" | "variable";
  id: string;
  name: string;
  reason: "both_changed" | "deleted_by_them" | "deleted_by_us";
}

type Json = Record<string, unknown>;

/** Key-sorted JSON for equality checks. */
function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}
function stable(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Json)[k]])) : v,
  );
}

/* ---------- items ---------- */

interface Entry {
  item: Item; // folders without children (see flatten)
  parent: string | null;
  index: number;
}

/** Tree -> id map. Folder entries hold their own fields only; children are separate entries. */
function flatten(items: Item[], parent: string | null = null, out = new Map<string, Entry>()): Map<string, Entry> {
  items.forEach((item, index) => {
    if (item.kind === "folder") {
      out.set(item.id, { item: { ...item, items: [] }, parent, index });
      flatten(item.items, item.id, out);
    } else {
      out.set(item.id, { item, parent, index });
    }
  });
  return out;
}

function build(entries: Map<string, Entry>): Item[] {
  const children = new Map<string | null, Entry[]>();
  for (const e of entries.values()) {
    // A parent folder deleted by the other side: keep the child at the root.
    const parent = e.parent && entries.has(e.parent) ? e.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), e]);
  }
  const make = (parent: string | null): Item[] =>
    (children.get(parent) ?? [])
      .sort((a, b) => a.index - b.index)
      .map((e) => (e.item.kind === "folder" ? ({ ...e.item, items: make(e.item.id) } as Folder) : e.item));
  return make(null);
}

function mergeItems(base: Item[], ours: Item[], theirs: Item[], conflicts: MergeConflict[]): Item[] {
  const b = flatten(base);
  const o = flatten(ours);
  const t = flatten(theirs);
  const merged = new Map<string, Entry>();
  const ids = new Set([...b.keys(), ...o.keys(), ...t.keys()]);

  for (const id of ids) {
    const be = b.get(id);
    const oe = o.get(id);
    const te = t.get(id);
    const conflict = (reason: MergeConflict["reason"], e: Entry) => conflicts.push({ kind: e.item.kind, id, name: e.item.name, reason });
    const position = (picked: Entry): Pick<Entry, "parent" | "index"> => {
      // Our move wins; otherwise keep the server position.
      const moved = be && oe && (oe.parent !== be.parent || oe.index !== be.index);
      const src = moved ? oe! : te ?? oe ?? picked;
      return { parent: src.parent, index: src.index };
    };

    if (!be) {
      // Added on one or both sides.
      if (oe && te && !same(oe.item, te.item)) {
        conflict("both_changed", oe);
        merged.set(id, te);
      } else merged.set(id, (te ?? oe)!);
      continue;
    }
    if (!oe && !te) continue; // deleted on both sides
    if (!oe) {
      // We deleted it; keep it only if they changed it meanwhile.
      if (same(te!.item, be.item)) continue;
      conflict("deleted_by_us", te!);
      merged.set(id, te!);
      continue;
    }
    if (!te) {
      // They deleted it; if we changed it, that is a conflict (their delete stands).
      if (!same(oe.item, be.item)) conflict("deleted_by_them", oe);
      continue;
    }
    const oursChanged = !same(oe.item, be.item);
    const theirsChanged = !same(te.item, be.item);
    let item = te.item;
    if (oursChanged && !theirsChanged) item = oe.item;
    else if (oursChanged && theirsChanged && !same(oe.item, te.item)) conflict("both_changed", oe);
    merged.set(id, { item, ...position(te) });
  }
  return build(merged);
}

/* ---------- variables ---------- */

export function mergeVariables(base: Variable[], ours: Variable[], theirs: Variable[], conflicts: MergeConflict[]): Variable[] {
  const strip = (v: Variable | undefined) => v && { key: v.key, value: v.value, enabled: v.enabled, secret: v.secret };
  const byKey = (list: Variable[]) => new Map(list.map((v) => [v.key, v]));
  const b = byKey(base);
  const o = byKey(ours);
  const t = byKey(theirs);
  // Order: server order, then keys we added.
  const keys = [...theirs.map((v) => v.key), ...ours.map((v) => v.key).filter((k) => !t.has(k))];
  const out: Variable[] = [];
  for (const key of [...new Set([...keys, ...base.map((v) => v.key)])]) {
    const bv = b.get(key);
    const ov = o.get(key);
    const tv = t.get(key);
    const oursChanged = !same(strip(ov), strip(bv));
    const theirsChanged = !same(strip(tv), strip(bv));
    let pick = tv;
    if (oursChanged && !theirsChanged) pick = ov;
    else if (oursChanged && theirsChanged && !same(strip(ov), strip(tv))) conflicts.push({ kind: "variable", id: key, name: key, reason: "both_changed" });
    if (pick) out.push(pick);
  }
  return out;
}

/** Field-by-field for simple settings. */
function mergeField<T>(base: T, ours: T, theirs: T, conflicts: MergeConflict[], owner: { kind: MergeConflict["kind"]; id: string; name: string }): T {
  if (same(ours, base)) return theirs;
  if (same(theirs, base) || same(ours, theirs)) return ours;
  conflicts.push({ ...owner, reason: "both_changed" });
  return theirs;
}

export function mergeCollection(base: Collection, ours: Collection, theirs: Collection): { merged: Collection; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const owner = { kind: "collection" as const, id: theirs.id, name: theirs.name };
  const settings: Json = {};
  for (const field of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    if (field === "items" || field === "variables") continue;
    settings[field] = mergeField((base as unknown as Json)[field], (ours as unknown as Json)[field], (theirs as unknown as Json)[field], conflicts, owner);
  }
  // One conflict entry for the collection settings is enough.
  const settingConflicts = conflicts.filter((c) => c.kind === "collection");
  conflicts.splice(0, conflicts.length, ...(settingConflicts.length ? [settingConflicts[0]!] : []));
  const merged = {
    ...(settings as unknown as Collection),
    id: theirs.id,
    variables: mergeVariables(base.variables ?? [], ours.variables ?? [], theirs.variables ?? [], conflicts),
    items: mergeItems(base.items ?? [], ours.items ?? [], theirs.items ?? [], conflicts),
  };
  return { merged, conflicts };
}

export function mergeEnvironment(base: Environment, ours: Environment, theirs: Environment): { merged: Environment; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const name = mergeField(base.name, ours.name, theirs.name, conflicts, { kind: "environment", id: theirs.id, name: theirs.name });
  const variables = mergeVariables(base.variables, ours.variables, theirs.variables, conflicts);
  return { merged: { ...theirs, name, variables }, conflicts };
}

/** Requests and folders present in `before` but not in `after` (for the trash). */
export function removedItems(before: Item[], after: Item[]): { item: Item; parent: string | null }[] {
  const a = flatten(after);
  const removed: { item: Item; parent: string | null }[] = [];
  const walk = (items: Item[], parent: string | null) => {
    for (const item of items) {
      if (!a.has(item.id)) removed.push({ item, parent }); // a removed folder carries its children
      else if (item.kind === "folder") walk(item.items, item.id);
    }
  };
  walk(before, null);
  return removed;
}
