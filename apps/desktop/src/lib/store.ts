import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { del, get, set } from "idb-keyval";
import {
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
  type Variable,
  type Workspace,
} from "@getman/core";
import type { ImportResult } from "@getman/importers";
import type { LogEntry, TestResult, VariableChange } from "@getman/scripts";
import { LOCAL_USER, seedWorkspace } from "./seed";

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
}

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
      const updateCol = (collectionId: string, fn: (c: Collection) => Collection) =>
        updateWs((ws) => ({ ...ws, collections: ws.collections.map((c) => (c.id === collectionId ? fn(c) : c)) }));

      return {
        workspaces: [firstWorkspace],
        activeWorkspaceId: firstWorkspace.id,
        selection: null,
        theme: "system",
        runtime: {},
        results: {},
        running: {},
        hydrated: false,

        setTheme: (theme) => setState({ theme }),
        select: (selection) => setState({ selection }),

        addWorkspace: (name) => {
          const ws = newWorkspace(name, LOCAL_USER);
          setState((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id, selection: null }));
        },
        setActiveWorkspace: (id) => setState({ activeWorkspaceId: id, selection: null }),
        renameWorkspace: (name) => updateWs((ws) => ({ ...ws, name })),

        updateCollection: updateCol,
        addCollection: (collection) => updateWs((ws) => ({ ...ws, collections: [...ws.collections, collection] })),
        removeCollection: (collectionId) => {
          updateWs((ws) => ({ ...ws, collections: ws.collections.filter((c) => c.id !== collectionId) }));
          if (getState().selection?.collectionId === collectionId) setState({ selection: null });
        },

        updateItem: (collectionId, itemId, fn) => updateCol(collectionId, (c) => ({ ...c, items: updateItem(c.items, itemId, fn) })),
        addItem: (collectionId, item, parentId) => updateCol(collectionId, (c) => ({ ...c, items: insertItem(c.items, item, parentId) })),
        removeItem: (collectionId, itemId) => {
          updateCol(collectionId, (c) => ({ ...c, items: removeItem(c.items, itemId) }));
          if (getState().selection?.itemId === itemId) setState({ selection: { collectionId } });
        },

        setActiveEnvironment: (id) => updateWs((ws) => ({ ...ws, activeEnvironmentId: id })),
        addEnvironment: (env) => updateWs((ws) => ({ ...ws, environments: [...ws.environments, env] })),
        updateEnvironment: (id, fn) => updateWs((ws) => ({ ...ws, environments: ws.environments.map((e) => (e.id === id ? fn(e) : e)) })),
        removeEnvironment: (id) =>
          updateWs((ws) => ({
            ...ws,
            environments: ws.environments.filter((e) => e.id !== id),
            activeEnvironmentId: ws.activeEnvironmentId === id ? undefined : ws.activeEnvironmentId,
          })),
        setGlobals: (globals) => updateWs((ws) => ({ ...ws, globals })),

        importResult: (result) =>
          updateWs((ws) => ({
            ...ws,
            collections: [...ws.collections, ...result.collections],
            environments: [...ws.environments, ...result.environments],
          })),

        applyChanges: (collectionId, changes) => {
          if (!changes.length) return;
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
        },

        setRunning: (requestId, running) => setState((s) => ({ running: { ...s.running, [requestId]: running } })),
        setResult: (requestId, result) => setState((s) => ({ results: { ...s.results, [requestId]: result } })),
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
      }),
      onRehydrateStorage: () => () => useStore.setState({ hydrated: true }),
    },
  ),
);

export function useActiveWorkspace(): Workspace {
  return useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? s.workspaces[0]!);
}
