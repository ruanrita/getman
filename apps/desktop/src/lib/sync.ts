/**
 * Server sync for workspaces with `storage.kind === "server"`.
 *
 * - Local edits: a store subscription diffs workspaces (updates are immutable,
 *   so changed objects have new identities), queues the changed collection /
 *   environment / globals, and pushes after a short debounce.
 * - Remote edits: one WebSocket per server delivers events, applied inside
 *   `remoteApply` so they are not pushed back.
 * - Conflicts: every write carries the version it was based on. On 409 the
 *   server copy wins and the user is told.
 * - Local values and secrets are stripped before upload and merged back in
 *   whenever server data replaces local data.
 *
 * See docs/architecture/storage.md.
 */
import { sanitizeVariables, type Collection, type Environment, type Variable, type Workspace } from "@getman/core";
import { ApiError, ServerApi, type WorkspaceSnapshot, type WorkspaceSummary } from "./api";
import { stable } from "./json";
import { useStore, type RemoteMeta } from "./store";
import { toast } from "./ui";

const PUSH_DEBOUNCE_MS = 600;
const RETRY_MS = 10_000;

/* ---------- helpers ---------- */

let applyingRemote = 0;
function remoteApply(fn: () => void) {
  applyingRemote++;
  try {
    fn();
  } finally {
    applyingRemote--;
  }
}


const keys = { collection: (id: string) => `c:${id}`, environment: (id: string) => `e:${id}`, globals: "g" };

const shareableCollection = (c: Collection): Collection => ({ ...c, variables: sanitizeVariables(c.variables) });
const shareableEnvironment = (e: Environment): Environment => ({ ...e, variables: sanitizeVariables(e.variables) });

/** Keeps this device's local values when server data replaces local data. */
function mergeLocal(incoming: Variable[], existing: Variable[] | undefined): Variable[] {
  if (!existing?.length) return incoming;
  return incoming.map((v) => {
    const local = existing.find((e) => e.key === v.key)?.localValue;
    return local !== undefined ? { ...v, localValue: local } : v;
  });
}

const state = () => useStore.getState();
const findWs = (id: string) => state().workspaces.find((w) => w.id === id);

export function apiFor(url: string): ServerApi {
  return new ServerApi(url, state().servers.find((s) => s.url === url)?.token);
}

function setStatus(wsId: string, status: RemoteMeta["status"], error?: string) {
  state().setRemote(wsId, (m) => m && { ...m, status, error });
}

/* ---------- loading ---------- */

function workspaceFromSnapshot(url: string, snap: WorkspaceSnapshot, previous: Workspace | undefined): Workspace {
  const prevCol = (id: string) => previous?.collections.find((c) => c.id === id);
  const prevEnv = (id: string) => previous?.environments.find((e) => e.id === id);
  const environments = snap.environments.map(({ environment: e }) => ({ ...e, variables: mergeLocal(e.variables, prevEnv(e.id)?.variables) }));
  return {
    id: snap.workspace.id,
    name: snap.workspace.name,
    storage: { kind: "server", url },
    members: snap.members.map((m) => ({ userId: m.userId, email: m.email, role: m.role })),
    collections: snap.collections.map(({ collection: c }) => ({ ...c, variables: mergeLocal(c.variables, prevCol(c.id)?.variables) })),
    environments,
    globals: mergeLocal(snap.globals.variables, previous?.globals),
    activeEnvironmentId: environments.some((e) => e.id === previous?.activeEnvironmentId) ? previous?.activeEnvironmentId : environments[0]?.id,
  };
}

function metaFromSnapshot(url: string, snap: WorkspaceSnapshot): RemoteMeta {
  const versions: Record<string, number> = {};
  const synced: Record<string, string> = {};
  for (const { collection, version } of snap.collections) {
    versions[collection.id] = version;
    synced[keys.collection(collection.id)] = stable(collection);
  }
  for (const { environment, version } of snap.environments) {
    versions[environment.id] = version;
    synced[keys.environment(environment.id)] = stable(environment);
  }
  synced[keys.globals] = stable(snap.globals.variables);
  return {
    serverUrl: url,
    role: snap.workspace.role,
    require2fa: snap.workspace.require2fa,
    members: snap.members,
    versions,
    globalsVersion: snap.globals.version,
    synced,
    status: "synced",
  };
}

/**
 * Downloads a workspace and replaces the local copy (keeping local values).
 * Pending local edits are pushed first so they are not lost.
 * `localValuesFrom` copies local values from another workspace (used when publishing).
 */
export async function loadServerWorkspace(url: string, workspaceId: string, localValuesFrom?: Workspace): Promise<void> {
  if (findWs(workspaceId)) await flush(workspaceId);
  const snap = await apiFor(url).snapshot(workspaceId);
  const ws = workspaceFromSnapshot(url, snap, localValuesFrom ?? findWs(workspaceId));
  remoteApply(() => {
    state().putWorkspace(ws);
    state().setRemote(ws.id, () => metaFromSnapshot(url, snap));
  });
  realtime(url).subscribe(ws.id);
}

/** Opens every workspace the account can see and drops local copies it lost access to. */
export async function syncAccount(url: string): Promise<WorkspaceSummary[]> {
  const { workspaces } = await apiFor(url).workspaces();
  realtime(url).ensure();
  const ids = new Set(workspaces.map((w) => w.id));
  for (const ws of state().workspaces) {
    if (ws.storage.kind === "server" && ws.storage.url === url && !ids.has(ws.id)) remoteApply(() => state().removeWorkspace(ws.id));
  }
  const failures: string[] = [];
  for (const w of workspaces) {
    try {
      await loadServerWorkspace(url, w.id);
    } catch (e) {
      // e.g. two_factor_required: keep going with the others.
      failures.push(`${w.name}: ${(e as Error).message}`);
    }
  }
  if (failures.length) toast(failures.join(" · "));
  return workspaces;
}

/** Re-reads name, members and role after workspace.updated / members.updated. */
async function refreshMeta(wsId: string) {
  const meta = state().remote[wsId];
  const ws = findWs(wsId);
  if (!meta || !ws) return;
  const snap = await apiFor(meta.serverUrl).snapshot(wsId);
  remoteApply(() => {
    state().putWorkspace({ ...ws, name: snap.workspace.name, members: snap.members.map((m) => ({ userId: m.userId, email: m.email, role: m.role })) });
    state().setRemote(wsId, (m) => m && { ...m, role: snap.workspace.role, require2fa: snap.workspace.require2fa, members: snap.members });
  });
}

/* ---------- pushing local edits ---------- */

type Op = { kind: "collection" | "environment"; id: string } | { kind: "globals" };
const queues = new Map<string, Map<string, Op>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const flushing = new Map<string, Promise<void>>();
const inflight = new Map<string, string>();

function enqueue(wsId: string, op: Op, delay = PUSH_DEBOUNCE_MS) {
  const q = queues.get(wsId) ?? new Map<string, Op>();
  q.set(op.kind === "globals" ? keys.globals : keys[op.kind](op.id), op);
  queues.set(wsId, q);
  clearTimeout(timers.get(wsId));
  timers.set(wsId, setTimeout(() => void flush(wsId), delay));
}

/** Pushes everything queued for a workspace. Safe to call concurrently. */
export function flush(wsId: string): Promise<void> {
  const running = flushing.get(wsId);
  if (running) return running.then(() => flush(wsId));
  const q = queues.get(wsId);
  if (!q?.size) return Promise.resolve();
  queues.delete(wsId);
  clearTimeout(timers.get(wsId));

  const job = (async () => {
    setStatus(wsId, "syncing");
    let offline = false;
    for (const [key, op] of q) {
      if (offline) {
        enqueue(wsId, op, RETRY_MS);
        continue;
      }
      try {
        await pushOne(wsId, key, op);
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "network") {
          offline = true;
          enqueue(wsId, op, RETRY_MS);
        } else if (err.code === "version_conflict") {
          applyConflict(wsId, op, err.details);
        } else if (err.status === 401) {
          const url = state().remote[wsId]?.serverUrl;
          if (url) signedOut(url, "Your session on this server ended. Sign in again.");
          return;
        } else {
          toast(`Sync failed: ${err.message}`);
          setStatus(wsId, "error", err.message);
        }
      }
    }
    if (offline) setStatus(wsId, "offline", "Server unreachable; changes are kept and will sync automatically.");
    else if (state().remote[wsId]?.status === "syncing") setStatus(wsId, "synced");
  })().finally(() => flushing.delete(wsId));
  flushing.set(wsId, job);
  return job;
}

async function pushOne(wsId: string, key: string, op: Op) {
  const ws = findWs(wsId);
  const meta = state().remote[wsId];
  if (!ws || !meta) return;
  const api = apiFor(meta.serverUrl);
  const record = (patch: (m: RemoteMeta) => RemoteMeta) => state().setRemote(wsId, (m) => m && patch(m));

  if (op.kind === "globals") {
    const vars = sanitizeVariables(ws.globals);
    const json = stable(vars);
    if (meta.synced[key] === json) return;
    inflight.set(key, json);
    const { version } = await api.putGlobals(wsId, vars, meta.globalsVersion);
    record((m) => ({ ...m, globalsVersion: version, synced: { ...m.synced, [key]: json } }));
    return;
  }

  const item = op.kind === "collection" ? ws.collections.find((c) => c.id === op.id) : ws.environments.find((e) => e.id === op.id);
  if (!item) {
    // Deleted locally.
    if (meta.versions[op.id] === undefined) return;
    try {
      await (op.kind === "collection" ? api.deleteCollection(wsId, op.id) : api.deleteEnvironment(wsId, op.id));
    } catch (e) {
      if ((e as ApiError).status !== 404) throw e;
    }
    record((m) => {
      const { [op.id]: _v, ...versions } = m.versions;
      const { [key]: _s, ...synced } = m.synced;
      return { ...m, versions, synced };
    });
    return;
  }

  const shareable = op.kind === "collection" ? shareableCollection(item as Collection) : shareableEnvironment(item as Environment);
  const json = stable(shareable);
  if (meta.synced[key] === json) return; // only local values changed
  inflight.set(key, json);
  const base = meta.versions[op.id] ?? 0;
  const { version } =
    op.kind === "collection"
      ? await api.putCollection(wsId, shareable as Collection, base)
      : await api.putEnvironment(wsId, shareable as Environment, base);
  record((m) => ({ ...m, versions: { ...m.versions, [op.id]: version }, synced: { ...m.synced, [key]: json } }));
}

/** Server copy wins; the user's edit to that item is replaced. */
function applyConflict(wsId: string, op: Op, details: any) {
  if (!details) return;
  if (op.kind === "collection") applyCollection(wsId, details.collection, details.version);
  else if (op.kind === "environment") applyEnvironment(wsId, details.environment, details.version);
  else applyGlobals(wsId, details.variables, details.version);
  const name = details.collection?.name ?? details.environment?.name ?? "Globals";
  toast(`"${name}" was changed by someone else at the same time. Their version was kept; please redo your last edit.`);
}

/* ---------- applying remote data ---------- */

function applyCollection(wsId: string, collection: Collection, version: number) {
  const ws = findWs(wsId);
  if (!ws) return;
  const prev = ws.collections.find((c) => c.id === collection.id);
  const merged = { ...collection, variables: mergeLocal(collection.variables, prev?.variables) };
  remoteApply(() => {
    state().putWorkspace({
      ...ws,
      collections: prev ? ws.collections.map((c) => (c.id === collection.id ? merged : c)) : [...ws.collections, merged],
    });
    state().setRemote(wsId, (m) => m && { ...m, versions: { ...m.versions, [collection.id]: version }, synced: { ...m.synced, [keys.collection(collection.id)]: stable(collection) } });
  });
}

function applyEnvironment(wsId: string, environment: Environment, version: number) {
  const ws = findWs(wsId);
  if (!ws) return;
  const prev = ws.environments.find((e) => e.id === environment.id);
  const merged = { ...environment, variables: mergeLocal(environment.variables, prev?.variables) };
  remoteApply(() => {
    state().putWorkspace({
      ...ws,
      environments: prev ? ws.environments.map((e) => (e.id === environment.id ? merged : e)) : [...ws.environments, merged],
    });
    state().setRemote(wsId, (m) => m && { ...m, versions: { ...m.versions, [environment.id]: version }, synced: { ...m.synced, [keys.environment(environment.id)]: stable(environment) } });
  });
}

function applyGlobals(wsId: string, variables: Variable[], version: number) {
  const ws = findWs(wsId);
  if (!ws) return;
  remoteApply(() => {
    state().putWorkspace({ ...ws, globals: mergeLocal(variables, ws.globals) });
    state().setRemote(wsId, (m) => m && { ...m, globalsVersion: version, synced: { ...m.synced, [keys.globals]: stable(variables) } });
  });
}

function applyDeletion(wsId: string, kind: "collection" | "environment", id: string) {
  const ws = findWs(wsId);
  if (!ws) return;
  remoteApply(() => {
    state().putWorkspace(
      kind === "collection" ? { ...ws, collections: ws.collections.filter((c) => c.id !== id) } : { ...ws, environments: ws.environments.filter((e) => e.id !== id) },
    );
    state().setRemote(wsId, (m) => {
      if (!m) return m;
      const { [id]: _v, ...versions } = m.versions;
      return { ...m, versions };
    });
  });
  if (kind === "collection" && state().selection?.collectionId === id) state().select(null);
}

/** True when an incoming copy is the echo of our own write (content already known). */
function isEcho(wsId: string, key: string, data: unknown): boolean {
  const json = stable(data);
  return inflight.get(key) === json || state().remote[wsId]?.synced[key] === json;
}

type ServerEvent =
  | { type: "collection.put"; workspaceId: string; collection: Collection; version: number }
  | { type: "collection.deleted"; workspaceId: string; id: string }
  | { type: "environment.put"; workspaceId: string; environment: Environment; version: number }
  | { type: "environment.deleted"; workspaceId: string; id: string }
  | { type: "globals.put"; workspaceId: string; globals: Variable[]; version: number }
  | { type: "workspace.updated" | "members.updated"; workspaceId: string }
  | { type: "workspace.removed"; workspaceId: string; reason: "deleted" | "access_revoked" };

function handleEvent(ev: ServerEvent) {
  const meta = state().remote[ev.workspaceId];
  if (!meta) return;
  const bump = (patch: (m: RemoteMeta) => RemoteMeta) => state().setRemote(ev.workspaceId, (m) => m && patch(m));

  switch (ev.type) {
    case "collection.put": {
      const id = ev.collection.id;
      if (ev.version <= (meta.versions[id] ?? 0)) return;
      const key = keys.collection(id);
      if (isEcho(ev.workspaceId, key, ev.collection)) bump((m) => ({ ...m, versions: { ...m.versions, [id]: ev.version }, synced: { ...m.synced, [key]: stable(ev.collection) } }));
      else applyCollection(ev.workspaceId, ev.collection, ev.version);
      return;
    }
    case "environment.put": {
      const id = ev.environment.id;
      if (ev.version <= (meta.versions[id] ?? 0)) return;
      const key = keys.environment(id);
      if (isEcho(ev.workspaceId, key, ev.environment)) bump((m) => ({ ...m, versions: { ...m.versions, [id]: ev.version }, synced: { ...m.synced, [key]: stable(ev.environment) } }));
      else applyEnvironment(ev.workspaceId, ev.environment, ev.version);
      return;
    }
    case "globals.put":
      if (ev.version <= meta.globalsVersion) return;
      if (isEcho(ev.workspaceId, keys.globals, ev.globals)) bump((m) => ({ ...m, globalsVersion: ev.version }));
      else applyGlobals(ev.workspaceId, ev.globals, ev.version);
      return;
    case "collection.deleted":
      return applyDeletion(ev.workspaceId, "collection", ev.id);
    case "environment.deleted":
      return applyDeletion(ev.workspaceId, "environment", ev.id);
    case "workspace.updated":
    case "members.updated":
      void refreshMeta(ev.workspaceId).catch(() => {});
      return;
    case "workspace.removed": {
      const name = findWs(ev.workspaceId)?.name ?? "A workspace";
      remoteApply(() => state().removeWorkspace(ev.workspaceId));
      toast(ev.reason === "deleted" ? `${name} was deleted by its owner.` : `You no longer have access to ${name}.`);
      return;
    }
  }
}

/* ---------- realtime connection (one per server) ---------- */

class Realtime {
  private socket?: WebSocket;
  private subs = new Set<string>();
  private retry = 1000;
  private stopped = false;
  private reconnecting = false;

  constructor(private url: string) {}

  /** Connects even without subscriptions, to receive user events such as workspace.added. */
  ensure() {
    if (!this.socket) this.connect();
  }

  subscribe(wsId: string) {
    this.subs.add(wsId);
    if (!this.socket) this.connect();
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "subscribe", workspaceId: wsId }));
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
  }

  private connect() {
    const token = state().servers.find((s) => s.url === this.url)?.token;
    if (!token || this.stopped) return;
    const socket = new WebSocket(apiFor(this.url).wsUrl());
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
    socket.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "ready") {
        this.retry = 1000;
        for (const id of this.subs) socket.send(JSON.stringify({ type: "subscribe", workspaceId: id }));
        // Catch up on anything missed while disconnected.
        if (this.reconnecting) for (const id of this.subs) void loadServerWorkspace(this.url, id).catch(() => {});
        this.reconnecting = false;
      } else if (msg.type === "workspace.added") {
        // Someone shared a workspace with us.
        void loadServerWorkspace(this.url, msg.workspaceId).then(
          () => toast(`You were added to "${findWs(msg.workspaceId)?.name}"`),
          () => {},
        );
      } else if (msg.type !== "subscribed" && msg.type !== "error") {
        handleEvent(msg);
      }
    };
    socket.onclose = (e) => {
      this.socket = undefined;
      if (this.stopped) return;
      if (e.code === 4401) {
        // Session revoked elsewhere (logout, password change).
        signedOut(this.url, "Your session on this server ended. Sign in again.");
        return;
      }
      this.reconnecting = true;
      for (const id of this.subs) setStatus(id, "offline", "Reconnecting to server…");
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    };
  }
}

const connections = new Map<string, Realtime>();
function realtime(url: string): Realtime {
  let rt = connections.get(url);
  if (!rt) {
    rt = new Realtime(url);
    connections.set(url, rt);
  }
  return rt;
}

/* ---------- accounts ---------- */

/** Forgets the session and removes that server's workspaces from this device. */
function signedOut(url: string, message?: string) {
  connections.get(url)?.stop();
  connections.delete(url);
  const account = state().servers.find((s) => s.url === url);
  if (account) state().upsertServer({ url, user: account.user });
  for (const ws of state().workspaces) {
    if (ws.storage.kind === "server" && ws.storage.url === url) remoteApply(() => state().removeWorkspace(ws.id));
  }
  if (message) toast(message);
}

export async function signOut(url: string) {
  try {
    await apiFor(url).logout();
  } catch {
    // Already invalid or offline: forget it locally anyway.
  }
  signedOut(url);
}

export async function signedIn(url: string, token: string, user: NonNullable<ReturnType<typeof state>["servers"][number]["user"]>) {
  state().upsertServer({ url, token, user });
  await syncAccount(url);
}

/* ---------- workspace operations ---------- */

export async function createServerWorkspace(url: string, name: string) {
  const ws = await apiFor(url).createWorkspace(name);
  await loadServerWorkspace(url, ws.id);
  state().setActiveWorkspace(ws.id);
}

/** Copies a local workspace to a server (as a new workspace) and opens it. The local copy is kept. */
export async function publishWorkspace(localId: string, url: string) {
  const local = findWs(localId);
  if (!local) return;
  const api = apiFor(url);
  const created = await api.createWorkspace(local.name);
  for (const c of local.collections) await api.putCollection(created.id, shareableCollection(c), 0);
  for (const e of local.environments) await api.putEnvironment(created.id, shareableEnvironment(e), 0);
  if (local.globals.length) await api.putGlobals(created.id, sanitizeVariables(local.globals), 1);
  await loadServerWorkspace(url, created.id, local);
  state().setActiveWorkspace(created.id);
}

/* ---------- start ---------- */

let started = false;

/** Call once after the store is hydrated. */
export function startSync() {
  if (started) return;
  started = true;

  useStore.subscribe((s, prev) => {
    if (applyingRemote) return;
    for (const ws of s.workspaces) {
      if (ws.storage.kind !== "server") continue;
      const before = prev.workspaces.find((w) => w.id === ws.id);
      if (!before || before === ws) continue;
      if (ws.collections !== before.collections) {
        for (const c of ws.collections) if (before.collections.find((b) => b.id === c.id) !== c) enqueue(ws.id, { kind: "collection", id: c.id });
        for (const b of before.collections) if (!ws.collections.some((c) => c.id === b.id)) enqueue(ws.id, { kind: "collection", id: b.id });
      }
      if (ws.environments !== before.environments) {
        for (const e of ws.environments) if (before.environments.find((b) => b.id === e.id) !== e) enqueue(ws.id, { kind: "environment", id: e.id });
        for (const b of before.environments) if (!ws.environments.some((e) => e.id === b.id)) enqueue(ws.id, { kind: "environment", id: b.id });
      }
      if (ws.globals !== before.globals) enqueue(ws.id, { kind: "globals" });
      if (ws.name !== before.name) {
        const url = ws.storage.url;
        clearTimeout(timers.get(`name:${ws.id}`));
        timers.set(
          `name:${ws.id}`,
          setTimeout(() => apiFor(url).updateWorkspace(ws.id, { name: ws.name }).catch((e) => toast(`Rename failed: ${(e as Error).message}`)), PUSH_DEBOUNCE_MS),
        );
      }
    }
  });

  // Refresh every signed-in server in the background. If one is unreachable, the
  // cached copies stay usable and the realtime connection retries, reloading on reconnect.
  for (const account of state().servers) {
    if (!account.token) continue;
    for (const ws of state().workspaces) {
      if (ws.storage.kind === "server" && ws.storage.url === account.url) realtime(account.url).subscribe(ws.id);
    }
    void syncAccount(account.url).catch((e) => {
      if ((e as ApiError).status === 401) signedOut(account.url, "Your session on this server ended. Sign in again.");
      else toast(`${account.url}: ${(e as Error).message}`);
    });
  }
}
