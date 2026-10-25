import type { Collection, Environment, Item, Role, Variable } from "@getman/core";
import { isTauri } from "./transport";

/** Error shape of the Getman server: `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

export interface ServerUser {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  emailVerified: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
}

export interface AddMemberResult {
  members: ServerMember[];
  /** Present when the email had no account and an invitation was created instead. */
  invite?: PendingInvite;
  code?: string;
  emailSent?: boolean;
}

export interface ServerMember {
  userId: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  require2fa: boolean;
}

export interface WorkspaceSnapshot {
  workspace: WorkspaceSummary;
  members: ServerMember[];
  globals: { variables: Variable[]; version: number };
  collections: { collection: Collection; version: number }[];
  environments: { environment: Environment; version: number }[];
}

export interface MergeConflict {
  kind: "request" | "folder" | "collection" | "environment" | "variable";
  id: string;
  name: string;
  reason: "both_changed" | "deleted_by_them" | "deleted_by_us";
}

/** Response of a save: the stored copy when others' changes were merged in, and conflicting items. */
export interface SaveResponse<T> {
  version: number;
  merged?: T;
  conflicts: MergeConflict[];
}

export interface CollectionVersion {
  version: number;
  savedAt: string;
  savedBy: string | null;
  name: string;
  changes: { id: string; name: string; change: "added" | "changed" | "deleted" }[];
  settingsChanged: boolean;
}

export interface ItemHistoryEntry {
  version: number;
  savedAt: string;
  savedBy: string | null;
  change: "created" | "changed" | "deleted";
  item: Item | null;
}

export interface TrashEntry {
  id: string;
  kind: "collection" | "environment" | "request" | "folder";
  name: string;
  collectionId: string | null;
  collectionName: string | null;
  deletedAt: string;
  deletedBy: string | null;
  expiresAt: string;
}

export type BackupSchedule = "manual" | "hourly" | "daily" | "weekly";

export type NewBackupTarget =
  | { kind: "s3"; config: { endpoint?: string; region?: string; bucket: string; prefix?: string; forcePathStyle?: boolean }; secrets: { accessKeyId: string; secretAccessKey: string } }
  | { kind: "local"; config: { folder: string }; secrets: Record<string, never> }
  | { kind: "postgres"; config: { table?: string }; secrets: { connectionString: string } };

export interface BackupTarget {
  id: string;
  name: string;
  kind: NewBackupTarget["kind"];
  config: Record<string, unknown>;
  schedule: BackupSchedule;
  retention: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "ok" | "error" | null;
  lastError: string | null;
}

export interface BackupRun {
  id: string;
  targetId: string;
  status: "running" | "ok" | "error";
  trigger: "manual" | "schedule";
  objectKey: string | null;
  sizeBytes: number | null;
  error: string | null;
  startedAt: string;
}

export interface RestoreResult {
  id: string;
  name: string;
  collections: number;
  environments: number;
}

export type LoginResult = { token: string; user: ServerUser } | { mfaRequired: true; mfaToken: string };

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * Talks to a Getman server. Inside Tauri it uses the native HTTP plugin (no
 * CORS); in the browser dev build it uses fetch and relies on the server's
 * CORS allow-list.
 */
export class ServerApi {
  constructor(
    public readonly url: string,
    public token?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.url}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, "network", `Cannot reach ${this.url}. Check the address and that the server is running. (${(e as Error).message ?? e})`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? "error", err.message ?? `HTTP ${res.status}`, err.details);
    }
    return data as T;
  }

  health = () => this.request<{ ok: boolean; name: string; apiVersion: number; features?: { email: boolean } }>("GET", "/health");

  /* auth & account */
  register = (body: { email: string; password: string; name: string }) =>
    this.request<{ token: string; user: ServerUser; verificationSent?: boolean }>("POST", "/auth/register", body);
  forgotPassword = (email: string) => this.request<{ ok: true; emailEnabled: boolean }>("POST", "/auth/password/forgot", { email });
  resetPassword = (email: string, code: string, newPassword: string) => this.request("POST", "/auth/password/reset", { email, code, newPassword });
  sendVerificationCode = () => this.request("POST", "/me/email/send-code");
  verifyEmail = (code: string) => this.request<{ ok: true; joined: { id: string; name: string; role: Role }[] }>("POST", "/me/email/verify", { code });
  acceptInvite = (code: string) => this.request<{ joined: { id: string; name: string; role: Role }[] }>("POST", "/invites/accept", { code });
  login = (email: string, password: string) => this.request<LoginResult>("POST", "/auth/login", { email, password });
  login2fa = (mfaToken: string, code: string) => this.request<{ token: string; user: ServerUser }>("POST", "/auth/login/2fa", { mfaToken, code });
  logout = () => this.request<{ ok: true }>("POST", "/auth/logout");
  me = () => this.request<{ user: ServerUser; recoveryCodesRemaining: number }>("GET", "/me");
  changePassword = (currentPassword: string, newPassword: string) =>
    this.request<{ sessionsRevoked: number }>("POST", "/me/password", { currentPassword, newPassword });
  sessions = () =>
    this.request<{ sessions: { id: string; userAgent: string | null; ip: string | null; lastUsedAt: string; current: boolean }[] }>("GET", "/me/sessions");
  revokeSession = (id: string) => this.request("DELETE", `/me/sessions/${id}`);
  setup2fa = () => this.request<{ secret: string; otpauthUrl: string }>("POST", "/me/2fa/setup");
  enable2fa = (code: string) => this.request<{ recoveryCodes: string[] }>("POST", "/me/2fa/enable", { code });
  disable2fa = (password: string, code: string) => this.request("POST", "/me/2fa/disable", { password, code });
  newRecoveryCodes = (code: string) => this.request<{ recoveryCodes: string[] }>("POST", "/me/2fa/recovery-codes", { code });

  /* workspaces */
  workspaces = () => this.request<{ workspaces: WorkspaceSummary[] }>("GET", "/workspaces");
  createWorkspace = (name: string) => this.request<WorkspaceSummary>("POST", "/workspaces", { name });
  snapshot = (id: string) => this.request<WorkspaceSnapshot>("GET", `/workspaces/${id}`);
  updateWorkspace = (id: string, body: { name?: string; require2fa?: boolean }) => this.request("PATCH", `/workspaces/${id}`, body);
  deleteWorkspace = (id: string) => this.request("DELETE", `/workspaces/${id}`);
  audit = (id: string) =>
    this.request<{ entries: { id: string; action: string; details: Record<string, unknown>; createdAt: string; actorEmail: string | null }[] }>(
      "GET",
      `/workspaces/${id}/audit`,
    );
  addMember = (id: string, email: string, role: Role) => this.request<AddMemberResult>("POST", `/workspaces/${id}/members`, { email, role });
  invites = (id: string) => this.request<{ invites: PendingInvite[] }>("GET", `/workspaces/${id}/invites`);
  resendInvite = (id: string, iid: string) => this.request<AddMemberResult>("POST", `/workspaces/${id}/invites/${iid}/resend`);
  revokeInvite = (id: string, iid: string) => this.request("DELETE", `/workspaces/${id}/invites/${iid}`);
  changeRole = (id: string, userId: string, role: Role) => this.request<{ members: ServerMember[] }>("PATCH", `/workspaces/${id}/members/${userId}`, { role });
  removeMember = (id: string, userId: string) => this.request("DELETE", `/workspaces/${id}/members/${userId}`);
  transfer = (id: string, userId: string) => this.request<{ members: ServerMember[] }>("POST", `/workspaces/${id}/transfer`, { userId });

  /* content */
  putCollection = (id: string, collection: Collection, baseVersion: number) =>
    this.request<SaveResponse<Collection>>("PUT", `/workspaces/${id}/collections/${collection.id}`, { collection, baseVersion });
  deleteCollection = (id: string, cid: string) => this.request("DELETE", `/workspaces/${id}/collections/${cid}`);
  putEnvironment = (id: string, environment: Environment, baseVersion: number) =>
    this.request<SaveResponse<Environment>>("PUT", `/workspaces/${id}/environments/${environment.id}`, { environment, baseVersion });
  deleteEnvironment = (id: string, eid: string) => this.request("DELETE", `/workspaces/${id}/environments/${eid}`);
  putGlobals = (id: string, variables: Variable[], baseVersion: number) =>
    this.request<{ version: number }>("PUT", `/workspaces/${id}/globals`, { variables, baseVersion });

  /* history and trash */
  collectionVersions = (id: string, cid: string) => this.request<{ versions: CollectionVersion[] }>("GET", `/workspaces/${id}/collections/${cid}/versions`);
  restoreCollectionVersion = (id: string, cid: string, version: number) =>
    this.request<SaveResponse<Collection>>("POST", `/workspaces/${id}/collections/${cid}/versions/${version}/restore`);
  itemHistory = (id: string, cid: string, itemId: string) =>
    this.request<{ history: ItemHistoryEntry[] }>("GET", `/workspaces/${id}/collections/${cid}/items/${itemId}/history`);
  environmentVersions = (id: string, eid: string) =>
    this.request<{ versions: { version: number; savedAt: string; savedBy: string | null; data: Environment }[] }>("GET", `/workspaces/${id}/environments/${eid}/versions`);
  trash = (id: string) => this.request<{ items: TrashEntry[]; retentionDays: number }>("GET", `/workspaces/${id}/trash`);
  restoreTrash = (id: string, tid: string) => this.request("POST", `/workspaces/${id}/trash/${tid}/restore`);
  purgeTrash = (id: string, tid: string) => this.request("DELETE", `/workspaces/${id}/trash/${tid}`);

  /* backups */
  backups = (id: string) => this.request<{ targets: BackupTarget[]; runs: BackupRun[]; localBackupsEnabled: boolean }>("GET", `/workspaces/${id}/backup-targets`);
  testBackupTarget = (id: string, body: NewBackupTarget) => this.request("POST", `/workspaces/${id}/backup-targets/test`, body);
  createBackupTarget = (id: string, body: NewBackupTarget & { name: string; schedule: BackupSchedule; retention: number; passphrase: string }) =>
    this.request<{ target: BackupTarget }>("POST", `/workspaces/${id}/backup-targets`, body);
  updateBackupTarget = (id: string, tid: string, body: Partial<Pick<BackupTarget, "name" | "schedule" | "retention" | "enabled">>) =>
    this.request<{ target: BackupTarget }>("PATCH", `/workspaces/${id}/backup-targets/${tid}`, body);
  deleteBackupTarget = (id: string, tid: string) => this.request("DELETE", `/workspaces/${id}/backup-targets/${tid}`);
  runBackup = (id: string, tid: string) => this.request<{ run: BackupRun }>("POST", `/workspaces/${id}/backup-targets/${tid}/run`);
  restoreRun = (id: string, rid: string, body: { name?: string; restoreMembers: boolean }) =>
    this.request<RestoreResult>("POST", `/workspaces/${id}/backup-runs/${rid}/restore`, body);
  restoreFile = (body: { file: string; passphrase: string; name?: string; restoreMembers: boolean }) => this.request<RestoreResult>("POST", "/restore", body);

  async downloadBackup(id: string, rid: string): Promise<Uint8Array> {
    const doFetch = isTauri() ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
    const res = await doFetch(`${this.url}/workspaces/${id}/backup-runs/${rid}/download`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new ApiError(res.status, "download_failed", `Download failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /* workspace AI */
  workspaceAi = (id: string) =>
    this.request<{ enabled: boolean; provider?: "anthropic" | "openai-compatible"; baseUrl?: string; model?: string; hasKey: boolean }>("GET", `/workspaces/${id}/ai`);
  configureWorkspaceAi = (id: string, body: { provider: "anthropic" | "openai-compatible" | null; baseUrl?: string | null; model?: string | null; apiKey?: string | null }) =>
    this.request("PUT", `/workspaces/${id}/ai`, body);
  workspaceAiChat = (id: string, body: { system: string; messages: { role: "user" | "assistant"; content: string }[] }) =>
    this.request<{ text: string; stopReason: string | null; model: string }>("POST", `/workspaces/${id}/ai/chat`, body);
  workspaceAiUsage = (id: string) =>
    this.request<{ usage: { email: string; requests: number; inputTokens: number; outputTokens: number }[] }>("GET", `/workspaces/${id}/ai/usage`);

  wsUrl(): string {
    return `${this.url.replace(/^http/i, "ws")}/ws`;
  }
}
