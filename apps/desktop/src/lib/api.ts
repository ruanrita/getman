import type { Collection, Environment, Role, Variable } from "@getman/core";
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

  health = () => this.request<{ ok: boolean; name: string; apiVersion: number }>("GET", "/health");

  /* auth & account */
  register = (body: { email: string; password: string; name: string }) => this.request<{ token: string; user: ServerUser }>("POST", "/auth/register", body);
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
  addMember = (id: string, email: string, role: Role) => this.request<{ members: ServerMember[] }>("POST", `/workspaces/${id}/members`, { email, role });
  changeRole = (id: string, userId: string, role: Role) => this.request<{ members: ServerMember[] }>("PATCH", `/workspaces/${id}/members/${userId}`, { role });
  removeMember = (id: string, userId: string) => this.request("DELETE", `/workspaces/${id}/members/${userId}`);
  transfer = (id: string, userId: string) => this.request<{ members: ServerMember[] }>("POST", `/workspaces/${id}/transfer`, { userId });

  /* content */
  putCollection = (id: string, collection: Collection, baseVersion: number) =>
    this.request<{ version: number }>("PUT", `/workspaces/${id}/collections/${collection.id}`, { collection, baseVersion });
  deleteCollection = (id: string, cid: string) => this.request("DELETE", `/workspaces/${id}/collections/${cid}`);
  putEnvironment = (id: string, environment: Environment, baseVersion: number) =>
    this.request<{ version: number }>("PUT", `/workspaces/${id}/environments/${environment.id}`, { environment, baseVersion });
  deleteEnvironment = (id: string, eid: string) => this.request("DELETE", `/workspaces/${id}/environments/${eid}`);
  putGlobals = (id: string, variables: Variable[], baseVersion: number) =>
    this.request<{ version: number }>("PUT", `/workspaces/${id}/globals`, { variables, baseVersion });

  wsUrl(): string {
    return `${this.url.replace(/^http/i, "ws")}/ws`;
  }
}
