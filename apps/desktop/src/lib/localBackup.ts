/**
 * Automatic backups of local workspaces (the ones that exist only on this
 * device) to a folder, default Documents/Getman/backups.
 *
 * Every minute, each local workspace that changed since its last backup and
 * whose interval elapsed is written as a Getman YAML file (unsaved drafts
 * included; secret and local values never). The newest N files per workspace
 * are kept. Restoring creates a new local workspace. Desktop app only.
 * See docs/features/local-backups.md.
 */
import { invoke } from "@tauri-apps/api/core";
import { newWorkspace, type Workspace } from "@getman/core";
import { exportGetman, importAny, slugify } from "@getman/importers";
import { effectiveWorkspace } from "./drafts";
import { LOCAL_USER } from "./seed";
import { useStore } from "./store";
import { isTauri } from "./transport";
import { toast } from "./ui";

export interface BackupFileInfo {
  name: string;
  size: number;
  modified: number;
}

export const localBackupsAvailable = () => isTauri();

/** FNV-1a, enough to tell whether the content changed. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const idTag = (ws: Workspace) => ws.id.slice(0, 8);
const pad = (n: number) => String(n).padStart(2, "0");
function fileName(ws: Workspace, d = new Date()) {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `getman-${slugify(ws.name).slice(0, 40)}-${idTag(ws)}-${stamp}.getman.yaml`;
}

/** Backups of one workspace are recognised by the workspace id in the name (renames keep working). */
export const belongsTo = (file: string, ws: Workspace) => file.includes(`-${idTag(ws)}-`);

export async function backupFolder(): Promise<string> {
  return useStore.getState().localBackup.dir ?? (await invoke<string>("backup_default_dir"));
}

function contentOf(ws: Workspace): string {
  const view = effectiveWorkspace(ws, useStore.getState().drafts);
  return exportGetman({ workspaceName: view.name, globals: view.globals, collections: view.collections, environments: view.environments });
}

export async function listBackups(): Promise<BackupFileInfo[]> {
  return invoke<BackupFileInfo[]>("backup_list", { dir: await backupFolder() });
}

/** Writes a backup of `ws` (if it changed, unless forced) and prunes old ones. Returns the file name. */
export async function backupNow(ws: Workspace, force = false): Promise<string | undefined> {
  const settings = useStore.getState().localBackup;
  const content = contentOf(ws);
  const h = hash(content);
  if (!force && settings.last[ws.id]?.hash === h) return undefined;
  const dir = await backupFolder();
  const name = fileName(ws);
  await invoke("backup_write", { dir, name, content });
  useStore.getState().setLocalBackup({ last: { ...useStore.getState().localBackup.last, [ws.id]: { hash: h, at: Date.now() } } });

  const mine = (await invoke<BackupFileInfo[]>("backup_list", { dir })).filter((f) => belongsTo(f.name, ws));
  for (const old of mine.slice(settings.keep)) await invoke("backup_delete", { dir, name: old.name }).catch(() => {});
  return name;
}

/** Restores a backup file as a new local workspace and opens it. */
export async function restoreBackup(name: string): Promise<void> {
  const text = await invoke<string>("backup_read", { dir: await backupFolder(), name });
  const data = importAny(text);
  const stamp = name.match(/(\d{8})-(\d{6})\.getman\.yaml$/);
  const when = stamp ? `${stamp[1]!.slice(6, 8)}/${stamp[1]!.slice(4, 6)} ${stamp[2]!.slice(0, 2)}:${stamp[2]!.slice(2, 4)}` : "backup";
  const ws: Workspace = {
    ...newWorkspace(`${data.workspaceName ?? "Workspace"} (restored ${when})`, LOCAL_USER),
    collections: data.collections,
    environments: data.environments,
    globals: data.globals ?? [],
  };
  ws.activeEnvironmentId = ws.environments[0]?.id;
  useStore.getState().putWorkspace(ws);
  useStore.getState().setActiveWorkspace(ws.id);
  toast(`Restored "${ws.name}". Secret values are not in backups: fill them in again.`);
}

export async function openBackupFolder() {
  await invoke("open_folder", { dir: await backupFolder() });
}

let started = false;

/** Checks every minute; the interval per workspace comes from the settings. */
export function startLocalBackups() {
  if (started || !isTauri()) return;
  started = true;
  const tick = async () => {
    const { localBackup, workspaces } = useStore.getState();
    if (!localBackup.enabled) return;
    for (const ws of workspaces) {
      if (ws.storage.kind !== "local") continue;
      const last = localBackup.last[ws.id];
      if (last && Date.now() - last.at < localBackup.intervalMin * 60_000) continue;
      try {
        await backupNow(ws);
      } catch (e) {
        toast(`Automatic backup failed: ${e}`);
        return;
      }
    }
  };
  setTimeout(() => void tick(), 20_000); // shortly after start
  setInterval(() => void tick(), 60_000);
}
