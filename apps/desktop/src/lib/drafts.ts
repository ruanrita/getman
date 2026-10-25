/**
 * Unsaved edits ("drafts").
 *
 * Editing a request, collection settings, an environment or the globals
 * creates a draft instead of changing the workspace. Drafts are kept on this
 * device (they survive restarts) and are what you see and send, but nothing
 * is synced or written to Git until you Save (Ctrl+S / Save all), which copies
 * the draft into the workspace - the only state the server and Git sync watch.
 *
 * Creating, deleting, renaming in the sidebar and importing stay immediate.
 */
import { findItemPath, updateItem, type Collection, type Environment, type RequestItem, type Variable, type Workspace } from "@getman/core";
import { stable } from "./json";

export type CollectionSettings = Omit<Collection, "items">;

export type Draft =
  | { kind: "request"; wsId: string; collectionId: string; id: string; value: RequestItem; base: string }
  | { kind: "collection"; wsId: string; id: string; value: CollectionSettings; base: string }
  | { kind: "environment"; wsId: string; id: string; value: Environment; base: string }
  | { kind: "globals"; wsId: string; id: "globals"; value: Variable[]; base: string };

export type DraftKind = Draft["kind"];

/** A draft as passed to editDraft (wsId and base are filled in by the store). */
export type DraftInput = Draft extends infer D ? (D extends Draft ? Omit<D, "base" | "wsId"> : never) : never;

export const draftKey = (wsId: string, kind: DraftKind, id: string) => `${wsId}|${kind}|${id}`;

const settingsOf = ({ items: _items, ...settings }: Collection): CollectionSettings => settings;

/**
 * Comparable form of a value. Device-local variable values are ignored: they
 * change when scripts run and are never shared, so they are not "edits".
 */
export function fingerprint(value: unknown): string {
  return stable(JSON.parse(JSON.stringify(value ?? null, (k, v) => (k === "localValue" ? undefined : v))));
}

/** The saved counterpart of a draft, or undefined if it was deleted (e.g. by a teammate). */
export function savedValueOf(ws: Workspace, d: Pick<Draft, "kind" | "id"> & { collectionId?: string }): unknown {
  switch (d.kind) {
    case "request": {
      const col = ws.collections.find((c) => c.id === d.collectionId);
      const found = col && findItemPath(col, d.id);
      return found?.item.kind === "request" ? found.item : undefined;
    }
    case "collection": {
      const col = ws.collections.find((c) => c.id === d.id);
      return col && settingsOf(col);
    }
    case "environment":
      return ws.environments.find((e) => e.id === d.id);
    case "globals":
      return ws.globals;
  }
}

/** True when the saved item changed after the draft was started (someone else saved it). */
export function savedChangedSince(ws: Workspace, d: Draft): boolean {
  const saved = savedValueOf(ws, d);
  return saved !== undefined && fingerprint(saved) !== d.base;
}

export function draftsOf(drafts: Record<string, Draft>, wsId: string): Draft[] {
  return Object.values(drafts).filter((d) => d.wsId === wsId);
}

const cache = new WeakMap<Workspace, { drafts: Record<string, Draft>; result: Workspace }>();

/** The workspace as the user sees it: saved state with this workspace's drafts on top. */
export function effectiveWorkspace(ws: Workspace, drafts: Record<string, Draft>): Workspace {
  const hit = cache.get(ws);
  if (hit && hit.drafts === drafts) return hit.result;
  const mine = draftsOf(drafts, ws.id);
  let result = ws;
  if (mine.length) {
    let { collections, environments, globals } = ws;
    for (const d of mine) {
      if (d.kind === "request") {
        collections = collections.map((c) => (c.id === d.collectionId ? { ...c, items: updateItem(c.items, d.id, () => d.value) } : c));
      } else if (d.kind === "collection") {
        collections = collections.map((c) => (c.id === d.id ? { ...c, ...d.value, items: c.items } : c));
      } else if (d.kind === "environment") {
        environments = environments.map((e) => (e.id === d.id ? d.value : e));
      } else {
        globals = d.value;
      }
    }
    result = { ...ws, collections, environments, globals };
  }
  cache.set(ws, { drafts, result });
  return result;
}
