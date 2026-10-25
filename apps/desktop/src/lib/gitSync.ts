/**
 * Git workspaces: the `.getman/` folder of a Git working copy is the source of truth.
 *
 * - Local edits are written to disk shortly after they happen (only changed
 *   files), so `git diff` always reflects the app.
 * - The folder is re-read when the window regains focus, after Pull, and on
 *   Refresh, so changes from `git pull`, branch switches or other editors show up.
 * - Device-local variable values are kept in the app cache and merged back by
 *   key; they are never written to the repository.
 *
 * Commands live in src-tauri/src/git.rs. See docs/architecture/storage.md.
 */
import { invoke } from "@tauri-apps/api/core";
import { newId, type Variable, type Workspace } from "@getman/core";
import { diffFiles, filesToWorkspace, workspaceToFiles, type FolderWorkspace } from "@getman/importers";
import { create } from "zustand";
import { useStore } from "./store";
import { isTauri } from "./transport";
import { toast } from "./ui";

export interface GitStatus {
  isRepo: boolean;
  hasGetman: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: string[];
}

interface GitOutput {
  ok: boolean;
  output: string;
}

/** Live Git state per workspace (not persisted). */
export const useGit = create<Record<string, { status?: GitStatus; error?: string; busy?: string; output?: string }>>(() => ({}));
const setGit = (wsId: string, patch: Partial<ReturnType<typeof useGit.getState>[string]>) =>
  useGit.setState((s) => ({ [wsId]: { ...s[wsId], ...patch } }));

const state = () => useStore.getState();
const findWs = (id: string) => state().workspaces.find((w) => w.id === id);
const dirOf = (ws: Workspace | undefined) => (ws?.storage.kind === "git" ? ws.storage.dir : undefined);

/** Last file contents known to be on disk, per workspace. */
const onDisk = new Map<string, Record<string, string>>();
let applying = 0;

/**
 * Written once when a workspace is created: Getman writes LF, so pin LF for
 * everyone (no CRLF warnings on Windows, no line-ending-only diffs between teammates).
 */
const GITATTRIBUTES = { path: ".gitattributes", content: "# Written by Getman: keep YAML line endings identical on every OS.\n* text eol=lf\n" };

export const gitAvailable = () => isTauri();

export function gitVersion(): Promise<string> {
  return invoke<string>("git_version");
}

export async function pickFolder(title: string): Promise<string | undefined> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title });
  return typeof dir === "string" ? dir : undefined;
}

function mergeLocal(incoming: Variable[], existing: Variable[] | undefined): Variable[] {
  if (!existing?.length) return incoming;
  return incoming.map((v) => {
    const prev = existing.find((e) => e.key === v.key);
    return prev?.localValue !== undefined ? { ...v, localValue: prev.localValue } : v;
  });
}

/** Builds the app workspace from folder data, keeping ids and local values from the cached copy. */
function toWorkspace(id: string, dir: string, data: FolderWorkspace, prev: Workspace | undefined): Workspace {
  const prevCol = (cid: string) => prev?.collections.find((c) => c.id === cid);
  const prevEnv = (eid: string) => prev?.environments.find((e) => e.id === eid);
  const environments = data.environments.map((e) => ({ ...e, variables: mergeLocal(e.variables, prevEnv(e.id)?.variables) }));
  return {
    id,
    name: data.name,
    storage: { kind: "git", dir },
    members: [{ userId: "local", email: "you@localhost", role: "owner" }],
    collections: data.collections.map((c) => ({ ...c, variables: mergeLocal(c.variables, prevCol(c.id)?.variables) })),
    environments,
    globals: mergeLocal(data.globals, prev?.globals),
    activeEnvironmentId: environments.some((e) => e.id === prev?.activeEnvironmentId) ? prev?.activeEnvironmentId : environments[0]?.id,
  };
}

export async function refreshStatus(wsId: string) {
  const dir = dirOf(findWs(wsId));
  if (!dir) return;
  try {
    setGit(wsId, { status: await invoke<GitStatus>("git_status", { dir }) });
  } catch (e) {
    setGit(wsId, { error: String(e) });
  }
}

/**
 * Re-reads `.getman/` and replaces the in-app workspace if the files changed.
 * A broken file (merge conflict, bad YAML) is reported and the app keeps the last good copy.
 */
export async function reloadFromDisk(wsId: string): Promise<void> {
  const ws = findWs(wsId);
  const dir = dirOf(ws);
  if (!ws || !dir) return;
  await flushWrites(wsId);
  const files = await invoke<Record<string, string>>("getman_read", { dir });
  const known = onDisk.get(wsId);
  if (known && JSON.stringify(Object.entries(known).sort()) === JSON.stringify(Object.entries(files).sort())) {
    setGit(wsId, { error: undefined });
    return;
  }
  let data: FolderWorkspace;
  try {
    data = filesToWorkspace(files);
  } catch (e) {
    setGit(wsId, { error: (e as Error).message });
    return;
  }
  onDisk.set(wsId, workspaceToFiles(data));
  applying++;
  try {
    state().putWorkspace(toWorkspace(wsId, dir, data, ws));
  } finally {
    applying--;
  }
  // Files in another layout (hand-edited, older writer) are normalised on the next local edit only.
  setGit(wsId, { error: undefined });
}

/**
 * Opens (or creates) the Getman workspace stored in `dir`. Reuses the cached
 * workspace for that folder if there is one, so local values survive.
 */
export async function openGitFolder(dir: string, createName?: string): Promise<string> {
  const files = await invoke<Record<string, string>>("getman_read", { dir });
  let data: FolderWorkspace;
  if (files["workspace.yaml"] === undefined) {
    if (!createName) throw new Error("This folder has no Getman workspace (.getman/workspace.yaml). Enter a name to create one.");
    data = { name: createName, globals: [], collections: [], environments: [] };
    const fresh = workspaceToFiles(data);
    await invoke("getman_write", { dir, writes: [GITATTRIBUTES, ...Object.entries(fresh).map(([path, content]) => ({ path, content }))] });
  } else {
    data = filesToWorkspace(files);
  }
  const existing = state().workspaces.find((w) => dirOf(w) === dir);
  const id = existing?.id ?? newId();
  onDisk.set(id, workspaceToFiles(data));
  setGit(id, { error: undefined, output: undefined }); // forget problems from an earlier read of this folder
  applying++;
  try {
    state().putWorkspace(toWorkspace(id, dir, data, existing));
  } finally {
    applying--;
  }
  state().setActiveWorkspace(id);
  void refreshStatus(id);
  return id;
}

/** Writes a local workspace into `dir/.getman` and opens it as a Git workspace. The local copy is kept. */
export async function moveToGitFolder(localId: string, dir: string): Promise<string> {
  const ws = findWs(localId);
  if (!ws) throw new Error("Workspace not found");
  const existing = await invoke<Record<string, string>>("getman_read", { dir });
  if (existing["workspace.yaml"] !== undefined) throw new Error("This folder already has a Getman workspace. Open it instead, or choose another folder.");
  const files = workspaceToFiles(ws);
  await invoke("getman_write", { dir, writes: [GITATTRIBUTES, ...Object.entries(files).map(([path, content]) => ({ path, content }))] });
  const id = await openGitFolder(dir);
  // Carry over this device's local values.
  const opened = findWs(id)!;
  applying++;
  try {
    state().putWorkspace({
      ...opened,
      globals: mergeLocal(opened.globals, ws.globals),
      collections: opened.collections.map((c) => ({ ...c, variables: mergeLocal(c.variables, ws.collections.find((x) => x.id === c.id)?.variables) })),
      environments: opened.environments.map((e) => ({ ...e, variables: mergeLocal(e.variables, ws.environments.find((x) => x.id === e.id)?.variables) })),
    });
  } finally {
    applying--;
  }
  return id;
}

export async function cloneRepository(url: string, parent: string, createName?: string): Promise<string> {
  const dir = await invoke<string>("git_clone", { url: url.trim(), parent });
  const files = await invoke<Record<string, string>>("getman_read", { dir });
  return openGitFolder(dir, files["workspace.yaml"] === undefined ? (createName ?? url.split(/[/:]/).pop()!.replace(/\.git$/, "")) : undefined);
}

/* ---------- writing local edits ---------- */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Map<string, Promise<void>>();

async function writeNow(wsId: string) {
  const ws = findWs(wsId);
  const dir = dirOf(ws);
  if (!ws || !dir) return;
  const files = workspaceToFiles(ws);
  const ops = diffFiles(onDisk.get(wsId) ?? {}, files);
  if (!ops.length) return;
  try {
    await invoke("getman_write", { dir, writes: ops });
    onDisk.set(wsId, files);
    void refreshStatus(wsId);
  } catch (e) {
    toast(`Could not save to ${dir}: ${e}`);
    setGit(wsId, { error: `Saving failed: ${e}` });
  }
}

function scheduleWrite(wsId: string) {
  clearTimeout(timers.get(wsId));
  timers.set(
    wsId,
    setTimeout(() => {
      timers.delete(wsId);
      const job = (writing.get(wsId) ?? Promise.resolve()).then(() => writeNow(wsId));
      writing.set(wsId, job);
    }, 400),
  );
}

/** Writes pending edits immediately (before pull/commit/reload). */
export async function flushWrites(wsId: string) {
  if (timers.has(wsId)) {
    clearTimeout(timers.get(wsId));
    timers.delete(wsId);
    writing.set(wsId, (writing.get(wsId) ?? Promise.resolve()).then(() => writeNow(wsId)));
  }
  await writing.get(wsId);
}

/* ---------- git actions ---------- */

async function run(wsId: string, label: string, fn: (dir: string) => Promise<GitOutput>) {
  const dir = dirOf(findWs(wsId));
  if (!dir) return;
  setGit(wsId, { busy: label, output: undefined });
  try {
    await flushWrites(wsId);
    const out = await fn(dir);
    setGit(wsId, { output: out.output });
    if (!out.ok) toast(`${label} failed. See the Git panel for details.`);
    return out;
  } catch (e) {
    setGit(wsId, { output: String(e) });
    toast(`${label} failed: ${e}`);
  } finally {
    setGit(wsId, { busy: undefined });
    await reloadFromDisk(wsId).catch(() => {});
    await refreshStatus(wsId);
  }
}

export const pull = (wsId: string) => run(wsId, "Pull", (dir) => invoke<GitOutput>("git_pull", { dir }));
export const commitAndPush = (wsId: string, message: string) => run(wsId, "Commit & push", (dir) => invoke<GitOutput>("git_commit_push", { dir, message }));

/* ---------- start ---------- */

let started = false;

export function startGitSync() {
  if (started || !isTauri()) return;
  started = true;

  useStore.subscribe((s, prev) => {
    if (applying) return;
    for (const ws of s.workspaces) {
      if (ws.storage.kind !== "git") continue;
      const before = prev.workspaces.find((w) => w.id === ws.id);
      if (before && before !== ws && (ws.collections !== before.collections || ws.environments !== before.environments || ws.globals !== before.globals || ws.name !== before.name)) {
        scheduleWrite(ws.id);
      }
    }
  });

  // The folder is the source of truth: load every Git workspace from disk at start.
  for (const ws of state().workspaces) {
    if (ws.storage.kind === "git") {
      void reloadFromDisk(ws.id)
        .then(() => refreshStatus(ws.id))
        .catch((e) => setGit(ws.id, { error: `Cannot read ${ws.storage.kind === "git" ? ws.storage.dir : ""}: ${e}` }));
    }
  }

  // Pick up `git pull`, branch switches or edits made outside Getman.
  window.addEventListener("focus", () => {
    const active = findWs(state().activeWorkspaceId);
    if (active?.storage.kind === "git") void reloadFromDisk(active.id).then(() => refreshStatus(active.id));
  });
}
