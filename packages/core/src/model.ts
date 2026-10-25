/**
 * Getman domain model.
 *
 * This is the single source of truth for every storage adapter, importer and
 * UI component. Keep it serialisable (plain JSON) - no classes, no Dates.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/**
 * A variable in any scope (global, collection, environment).
 *
 * - `value` is the shared value: synced to the server / Git and exported.
 * - `localValue` is the "current value": it lives only on this device and
 *   overrides `value` when present. Never synced, never exported.
 * - `secret` variables are masked in the UI and their `value` is stripped
 *   on export/sync, so secrets only ever exist in `localValue`.
 */
export interface Variable {
  id: string;
  key: string;
  value: string;
  localValue?: string;
  enabled: boolean;
  secret: boolean;
}

export type BodyMode = "none" | "json" | "raw" | "form-urlencoded" | "form-data";

export interface RequestBody {
  mode: BodyMode;
  raw: string;
  form: KeyValue[];
}

export type Auth =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; in: "header" | "query" };

export interface Scripts {
  /** Runs before the request is sent. Typically sets variables. */
  preRequest: string;
  /** Runs after the response arrives. Assertions and variable extraction. */
  test: string;
}

export interface RequestItem {
  kind: "request";
  id: string;
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  scripts: Scripts;
}

export interface Folder {
  kind: "folder";
  id: string;
  name: string;
  description?: string;
  items: Item[];
  auth: Auth;
  scripts: Scripts;
}

export type Item = RequestItem | Folder;

export interface Collection {
  id: string;
  name: string;
  description?: string;
  items: Item[];
  variables: Variable[];
  auth: Auth;
  scripts: Scripts;
}

export interface Environment {
  id: string;
  name: string;
  variables: Variable[];
}

/** Owner > Admin > Editor > Viewer. See permissions.ts. */
export type Role = "owner" | "admin" | "editor" | "viewer";

export interface Member {
  userId: string;
  email: string;
  role: Role;
}

export type StorageConfig =
  | { kind: "local" }
  | { kind: "server"; url: string }
  /** A folder inside a Git working copy; files live in `<dir>/.getman/`. */
  | { kind: "git"; dir: string };

export interface Workspace {
  id: string;
  name: string;
  storage: StorageConfig;
  members: Member[];
  collections: Collection[];
  environments: Environment[];
  globals: Variable[];
  activeEnvironmentId?: string;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  timeMs: number;
  sizeBytes: number;
}
