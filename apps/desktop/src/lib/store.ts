import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { del, get, set } from "idb-keyval";
import {
  can,
  insertItem,
  newWorkspace,
  removeItem,
  updateItem,
  variable,
  type Collection,
  type Environment,
  type HttpResponse,
  type Item,
  type PreparedRequest,
  type Action,
  type Role,
  type Variable,
  type Workspace,
} from "@getman/core";
import type { ImportResult } from "@getman/importers";
import type { LogEntry, TestResult, VariableChange } from "@getman/scripts";
import { DEFAULT_AI_SETTINGS, type AiSettings } from "./aiConfig";
import { draftKey, draftsOf, effectiveWorkspace, fingerprint, savedChangedSince, savedValueOf, type Draft, type DraftInput } from "./drafts";
import type { ServerMember, ServerUser } from "./api";
import { LOCAL_USER, seedWorkspace } from "./seed";
import { toast } from "./ui";

/** A signed-in (or signed-out) account on a Getman server. */
export interface ServerAccount {
  url: string;
  token?: string;
  user?: ServerUser;
}

/** Sync bookkeeping for a workspace stored on a server. */
export interface RemoteMeta {
  serverUrl: string;
  role: Role;
  require2fa: boolean;
  members: ServerMember[];
  /** Server version of each collection / environment, by id. */
  versions: Record<string, number>;
  globalsVersion: number;
  /** Sanitized JSON last known to be on the server, by sync key. Avoids pushing no-op changes. */
  synced: Record<string, string>;
  status: "synced" | "syncing" | "offline" | "error";
  error?: string;
}

export interface RunResult {
  response?: HttpResponse;
  error?: string;
  prepared?: PreparedRequest;
  tests: (TestResult & { source: string })[];
  logs: (LogEntry & { source: string })[];
}

export type Selection = { collectionId: string; itemId?: string } | null;
export type Theme = "system" | "light" | "dark";

interface State {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  selection: Selection;
  theme: Theme;
  /** Variables set with pm.variables.set: live for this session only. */
  runtime: Record<string, string>;
  results: Record<string, RunResult>;
  running: Record<string, boolean>;
  hydrated: boolean;
  servers: ServerAccount[];
  remote: Record<string, RemoteMeta>;
  ai: AiSettings;
  aiOpen: boolean;
  /** Unsaved edits, keyed by draftKey(). Kept on this device; see drafts.ts. */
  drafts: Record<string, Draft>;
  /** Automatic backups of local workspaces (localBackup.ts). */
  localBackup: LocalBackupSettings;
}

export interface LocalBackupSettings {
  enabled: boolean;
  /** Undefined = Documents/Getman/backups. */
  dir?: string;
  intervalMin: number;
  keep: number;
  /** Last backup per workspace: content hash and time. */
  last: Record<string, { hash: string; at: number }>;
}

export type SaveResult = "saved" | "conflict" | "denied" | "missing" | "none";

interface Actions {
  setTheme(theme: Theme): void;
  select(selection: Selection): void;
  addWorkspace(name: string): void;
  setActiveWorkspace(id: string): void;
  renameWorkspace(name: string): void;
  updateCollection(collectionId: string, fn: (c: Collection) => Collection): void;
  addCollection(collection: Collection): void;
  removeCollection(collectionId: string): void;
  updateItem(collectionId: string, itemId: string, fn: (i: Item) => Item): void;
  addItem(collectionId: string, item: Item, parentId?: string): void;
  removeItem(collectionId: string, itemId: string): void;
  setActiveEnvironment(id: string | undefined): void;
  addEnvironment(env: Environment): void;
  updateEnvironment(id: string, fn: (e: Environment) => Environment): void;
  removeEnvironment(id: string): void;
  setGlobals(vars: Variable[]): void;
  importResult(result: ImportResult): void;
  applyChanges(collectionId: string, changes: VariableChange[]): void;
  setRunning(requestId: string, running: boolean): void;
  setResult(requestId: string, result: RunResult): void;
  upsertServer(account: ServerAccount): void;
  removeServer(url: string): void;
  /** Adds or replaces a whole workspace (used by sync). */
  putWorkspace(ws: Workspace): void;
  removeWorkspace(id: string): void;
  setRemote(workspaceId: string, fn: (meta: RemoteMeta | undefined) => RemoteMeta | undefined): void;
  setAi(patch: Partial<AiSettings>): void;
  toggleAi(open?: boolean): void;
  /** Records an edit as a draft of the active workspace (dropped again if it equals the saved value). */
  editDraft(draft: DraftInput): void;
  discardDraft(key: string): void;
  /**
   * Copies a draft into the workspace, which triggers sync. Returns "conflict"
   * (and keeps the draft) if someone else saved the item meanwhile, unless `force`.
   */
  saveDraft(key: string, force?: boolean): SaveResult;
  /** Saves every draft of the active workspace; returns the keys left unsaved because of conflicts. */
  saveAll(force?: boolean): string[];
  setLocalBackup(patch: Partial<LocalBackupSettings>): void;
}

/**
 * For server workspaces, blocks edits the member's role does not allow.
 * The server enforces the same rules; this only gives immediate feedback.
 */
function allowed(s: State, action: Action): boolean {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  if (ws?.storage.kind !== "server") return true;
  const role = s.remote[ws.id]?.role;
  if (role && can(role, action)) return true;
  toast(`Read-only: your role (${role ?? "unknown"}) cannot change this workspace.`);
  return false;
}

const idbStorage: StateStorage = {
  getItem: async (name) => (await get<string>(name)) ?? null,
  setItem: (name, value) => set(name, value),
  removeItem: (name) => del(name),
};

/**
 * Writes a script-set value. Like Postman's "current value", it goes to the
 * device-local value so tokens set by scripts are never synced or exported.
 */
function upsertLocal(vars: Variable[], key: string, value: string | undefined): Variable[] {
  const existing = vars.find((v) => v.key === key);
  if (value === undefined) return existing ? vars.map((v) => (v.key === key ? { ...v, localValue: undefined } : v)) : vars;
  if (existing) return vars.map((v) => (v.key === key ? { ...v, localValue: value } : v));
  return [...vars, variable(key, "", { localValue: value })];
}

const firstWorkspace = seedWorkspace();

export const useStore = create<State & Actions>()(
  persist(
    (setState, getState) => {
      const updateWs = (fn: (ws: Workspace) => Workspace) =>
        setState((s) => ({ workspaces: s.workspaces.map((ws) => (ws.id === s.activeWorkspaceId ? fn(ws) : ws)) }));
      /** Like updateWs, but only if the role allows `action` (server workspaces). */
      const guarded = (action: Action, fn: (ws: Workspace) => Workspace) => {
        if (allowed(getState(), action)) updateWs(fn);
      };
      const activeWs = () => {
        const s = getState();
        return s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]!;
      };
      const dropDrafts = (match: (d: Draft) => boolean) =>
        setState((s) => ({ drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, d]) => d.wsId !== s.activeWorkspaceId || !match(d))) }));
      /** Fingerprint of a draft's saved counterpart captured before applyChanges mutates it. */
      const savedBefore = new Map<string, string>();
      const fingerprintBefore = (key: string) => savedBefore.get(key);
      const updateCol = (collectionId: string, fn: (c: Collection) => Collection) =>
        guarded("collections.write", (ws) => ({ ...ws, collections: ws.collections.map((c) => (c.id === collectionId ? fn(c) : c)) }));

      return {
        workspaces: [firstWorkspace],
        activeWorkspaceId: firstWorkspace.id,
        selection: null,
        theme: "system",
        runtime: {},
        results: {},
        running: {},
        hydrated: false,
        servers: [],
        remote: {},
        ai: DEFAULT_AI_SETTINGS,
        aiOpen: false,
        drafts: {},
        localBackup: { enabled: true, intervalMin: 10, keep: 30, last: {} },

        setTheme: (theme) => setState({ theme }),
        select: (selection) => setState({ selection }),

        addWorkspace: (name) => {
          const ws = newWorkspace(name, LOCAL_USER);
          setState((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id, selection: null }));
        },
        setActiveWorkspace: (id) => setState({ activeWorkspaceId: id, selection: null }),
        renameWorkspace: (name) => updateWs((ws) => ({ ...ws, name })),

        updateCollection: updateCol,
        addCollection: (collection) => guarded("collections.write", (ws) => ({ ...ws, collections: [...ws.collections, collection] })),
        removeCollection: (collectionId) => {
          guarded("collections.write", (ws) => ({ ...ws, collections: ws.collections.filter((c) => c.id !== collectionId) }));
          dropDrafts((d) => (d.kind === "request" ? d.collectionId : d.kind === "collection" ? d.id : undefined) === collectionId && !activeWs().collections.some((c) => c.id === collectionId));
          if (getState().selection?.collectionId === collectionId) setState({ selection: null });
        },

        updateItem: (collectionId, itemId, fn) => {
          updateCol(collectionId, (c) => ({ ...c, items: updateItem(c.items, itemId, fn) }));
          const s = getState();
          const key = draftKey(s.activeWorkspaceId, "request", itemId);
          const d = s.drafts[key];
          const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
          const saved = ws && d ? savedValueOf(ws, d) : undefined;
          if (d?.kind === "request" && saved) {
            const name = (saved as { name: string }).name;
            setState({ drafts: { ...s.drafts, [key]: { ...d, value: { ...d.value, name }, base: fingerprint(saved) } } });
          }
        },
        addItem: (collectionId, item, parentId) => updateCol(collectionId, (c) => ({ ...c, items: insertItem(c.items, item, parentId) })),
        removeItem: (collectionId, itemId) => {
          updateCol(collectionId, (c) => ({ ...c, items: removeItem(c.items, itemId) }));
          dropDrafts((d) => d.kind === "request" && d.collectionId === collectionId && !savedValueOf(activeWs(), d));
          if (getState().selection?.itemId === itemId) setState({ selection: { collectionId } });
        },

        setActiveEnvironment: (id) => updateWs((ws) => ({ ...ws, activeEnvironmentId: id })),
        addEnvironment: (env) => guarded("environments.write", (ws) => ({ ...ws, environments: [...ws.environments, env] })),
        updateEnvironment: (id, fn) =>
          guarded("environments.write", (ws) => ({ ...ws, environments: ws.environments.map((e) => (e.id === id ? fn(e) : e)) })),
        removeEnvironment: (id) => {
          guarded("environments.write", (ws) => ({
            ...ws,
            environments: ws.environments.filter((e) => e.id !== id),
            activeEnvironmentId: ws.activeEnvironmentId === id ? undefined : ws.activeEnvironmentId,
          }));
          dropDrafts((d) => d.kind === "environment" && d.id === id && !activeWs().environments.some((e) => e.id === id));
        },
        setGlobals: (globals) => guarded("environments.write", (ws) => ({ ...ws, globals })),

        importResult: (result) =>
          guarded("collections.write", (ws) => ({
            ...ws,
            collections: [...ws.collections, ...result.collections],
            environments: [...ws.environments, ...result.environments],
          })),

        applyChanges: (collectionId, changes) => {
          if (!changes.length) return;
          savedBefore.clear();
          for (const [key, d] of Object.entries(getState().drafts)) {
            if (d.wsId === getState().activeWorkspaceId && d.kind !== "request") savedBefore.set(key, fingerprint(savedValueOf(activeWs(), d)));
          }
          const runtime = { ...getState().runtime };
          updateWs((ws) => {
            let { environments, globals, collections } = ws;
            for (const ch of changes) {
              if (ch.scope === "runtime") {
                if (ch.value === undefined) delete runtime[ch.key];
                else runtime[ch.key] = ch.value;
              } else if (ch.scope === "environment" && ws.activeEnvironmentId) {
                environments = environments.map((e) =>
                  e.id === ws.activeEnvironmentId ? { ...e, variables: upsertLocal(e.variables, ch.key, ch.value) } : e,
                );
              } else if (ch.scope === "globals") {
                globals = upsertLocal(globals, ch.key, ch.value);
              } else if (ch.scope === "collection") {
                collections = collections.map((c) =>
                  c.id === collectionId ? { ...c, variables: upsertLocal(c.variables, ch.key, ch.value) } : c,
                );
              }
            }
            return { ...ws, environments, globals, collections };
          });
          setState({ runtime });
          const s = getState();
          const ws = activeWs();
          const drafts = { ...s.drafts };
          for (const [key, d] of Object.entries(drafts)) {
            if (d.wsId !== ws.id || d.kind === "request") continue;
            if (d.kind === "collection" && d.id !== collectionId) continue;
            if (d.kind === "environment" && d.id !== ws.activeEnvironmentId) continue;
            const scope = d.kind === "collection" ? "collection" : d.kind === "environment" ? "environment" : "globals";
            let vars = d.kind === "globals" ? d.value : d.value.variables;
            for (const ch of changes) if (ch.scope === scope) vars = upsertLocal(vars, ch.key, ch.value);
            const value = d.kind === "globals" ? vars : { ...d.value, variables: vars };
            // A key a script created exists in both copies now, so it is not an edit.
            const base = d.base === fingerprintBefore(key) ? fingerprint(savedValueOf(ws, d)) : d.base;
            drafts[key] = { ...d, value, base } as Draft;
          }
          setState({ drafts });
        },

        setRunning: (requestId, running) => setState((s) => ({ running: { ...s.running, [requestId]: running } })),
        setResult: (requestId, result) => setState((s) => ({ results: { ...s.results, [requestId]: result } })),

        upsertServer: (account) =>
          setState((s) => ({ servers: [...s.servers.filter((a) => a.url !== account.url), account] })),
        removeServer: (url) => setState((s) => ({ servers: s.servers.filter((a) => a.url !== url) })),
        putWorkspace: (ws) =>
          setState((s) => ({
            workspaces: s.workspaces.some((w) => w.id === ws.id) ? s.workspaces.map((w) => (w.id === ws.id ? ws : w)) : [...s.workspaces, ws],
          })),
        removeWorkspace: (id) =>
          setState((s) => {
            const workspaces = s.workspaces.filter((w) => w.id !== id);
            const { [id]: _gone, ...remote } = s.remote;
            if (!workspaces.length) workspaces.push(seedWorkspace());
            const active = s.activeWorkspaceId === id ? workspaces[0]!.id : s.activeWorkspaceId;
            const drafts = Object.fromEntries(Object.entries(s.drafts).filter(([, d]) => d.wsId !== id));
            return { workspaces, remote, drafts, activeWorkspaceId: active, selection: s.activeWorkspaceId === id ? null : s.selection };
          }),
        setRemote: (workspaceId, fn) =>
          setState((s) => {
            const next = fn(s.remote[workspaceId]);
            const { [workspaceId]: _old, ...rest } = s.remote;
            return { remote: next ? { ...rest, [workspaceId]: next } : rest };
          }),
        editDraft: (input) => {
          const s = getState();
          const ws = activeWs();
          const key = draftKey(ws.id, input.kind, input.id);
          const saved = savedValueOf(ws, input as Draft);
          const existing = s.drafts[key];
          if (saved !== undefined && fingerprint(saved) === fingerprint(input.value) && (!existing || !savedChangedSince(ws, existing))) {
            // Nothing shareable changed. Device-local values (never synced) are kept straight away.
            if (input.kind === "environment") updateWs((w) => ({ ...w, environments: w.environments.map((e) => (e.id === input.id ? (input.value as Environment) : e)) }));
            if (input.kind === "globals") updateWs((w) => ({ ...w, globals: input.value as Variable[] }));
            if (input.kind === "collection") updateWs((w) => ({ ...w, collections: w.collections.map((c) => (c.id === input.id ? { ...c, ...(input.value as object), items: c.items } : c)) }));
            const { [key]: _gone, ...rest } = getState().drafts;
            return setState({ drafts: rest });
          }
          const draft = { ...input, wsId: ws.id, base: existing?.base ?? fingerprint(saved) } as Draft;
          setState({ drafts: { ...s.drafts, [key]: draft } });
        },
        discardDraft: (key) =>
          setState((s) => {
            const { [key]: _gone, ...rest } = s.drafts;
            return { drafts: rest };
          }),
        saveDraft: (key, force = false) => {
          const s = getState();
          const d = s.drafts[key];
          if (!d) return "none";
          const ws = s.workspaces.find((w) => w.id === d.wsId);
          if (!ws || ws.id !== s.activeWorkspaceId) return "missing";
          if (!allowed(s, d.kind === "environment" || d.kind === "globals" ? "environments.write" : "collections.write")) return "denied";
          if (!force && savedChangedSince(ws, d)) return "conflict";

          const exists = savedValueOf(ws, d) !== undefined;
          if (d.kind === "request") {
            if (exists) updateWs((w) => ({ ...w, collections: w.collections.map((c) => (c.id === d.collectionId ? { ...c, items: updateItem(c.items, d.id, () => d.value) } : c)) }));
            else if (ws.collections.some((c) => c.id === d.collectionId)) {
              // Deleted by someone else while you edited it: bring it back.
              updateWs((w) => ({ ...w, collections: w.collections.map((c) => (c.id === d.collectionId ? { ...c, items: insertItem(c.items, d.value) } : c)) }));
              toast(`"${d.value.name}" had been deleted by someone else; your version was saved again.`);
            } else return "missing";
          } else if (d.kind === "collection") {
            if (!exists) return "missing";
            updateWs((w) => ({ ...w, collections: w.collections.map((c) => (c.id === d.id ? { ...c, ...d.value, items: c.items } : c)) }));
          } else if (d.kind === "environment") {
            updateWs((w) => ({ ...w, environments: exists ? w.environments.map((e) => (e.id === d.id ? d.value : e)) : [...w.environments, d.value] }));
          } else {
            updateWs((w) => ({ ...w, globals: d.value }));
          }
          getState().discardDraft(key);
          return "saved";
        },
        saveAll: (force = false) => {
          const s = getState();
          const conflicts: string[] = [];
          for (const d of draftsOf(s.drafts, s.activeWorkspaceId)) {
            const key = draftKey(d.wsId, d.kind, d.id);
            if (getState().saveDraft(key, force) === "conflict") conflicts.push(key);
          }
          return conflicts;
        },

        setLocalBackup: (patch) => setState((s) => ({ localBackup: { ...s.localBackup, ...patch } })),
        setAi: (patch) => setState((s) => ({ ai: { ...s.ai, ...patch } })),
        toggleAi: (open) => setState((s) => ({ aiOpen: open ?? !s.aiOpen })),
      };
    },
    {
      name: "getman-state",
      version: 1,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({
        workspaces: s.workspaces,
        activeWorkspaceId: s.activeWorkspaceId,
        selection: s.selection,
        theme: s.theme,
        // Session tokens live here for now; moving them to the OS keychain is planned (docs/limitations.md).
        servers: s.servers,
        remote: s.remote,
        // The personal AI key is stored with them, same limitation.
        ai: s.ai,
        aiOpen: s.aiOpen,
        // Unsaved edits survive restarts: closing the app never loses work.
        drafts: s.drafts,
        localBackup: s.localBackup,
      }),
      onRehydrateStorage: () => () => useStore.setState({ hydrated: true }),
    },
  ),
);

export function useActiveWorkspace(): Workspace {
  return useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]!);
}

/** The active workspace with this device's unsaved drafts applied: what the user sees and sends. */
export function useEffectiveWorkspace(): Workspace {
  const ws = useActiveWorkspace();
  const drafts = useStore((s) => s.drafts);
  return effectiveWorkspace(ws, drafts);
}

export function effectiveActiveWorkspace(): Workspace {
  const s = useStore.getState();
  return effectiveWorkspace(s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]!, s.drafts);
}
