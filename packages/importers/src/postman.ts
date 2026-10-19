/**
 * Postman Collection v2.0 / v2.1 and Postman Environment import/export.
 * Spec: https://schema.postman.com/collection/json/v2.1.0/draft-07/docs/index.html
 */
import {
  emptyScripts,
  keyValue,
  newId,
  sanitizeVariables,
  splitUrl,
  variable,
  type Auth,
  type Collection,
  type Environment,
  type Folder,
  type Item,
  type KeyValue,
  type RequestBody,
  type RequestItem,
  type Scripts,
  type Variable,
  HTTP_METHODS,
  type HttpMethod,
} from "@getman/core";

/* ---------- Postman types (only the parts we read/write) ---------- */

interface PmKV {
  key: string;
  value?: string;
  disabled?: boolean;
  description?: string;
  type?: string;
}
interface PmAuthKV {
  key: string;
  value?: unknown;
}
interface PmAuth {
  type: string;
  [k: string]: PmAuthKV[] | Record<string, unknown> | string | undefined;
}
interface PmEvent {
  listen: "prerequest" | "test";
  script?: { exec?: string | string[]; type?: string };
}
interface PmUrl {
  raw?: string;
  protocol?: string;
  host?: string | string[];
  path?: string | string[];
  port?: string;
  query?: PmKV[];
}
interface PmRequest {
  method?: string;
  header?: PmKV[] | string;
  url?: string | PmUrl;
  body?: { mode?: string; raw?: string; urlencoded?: PmKV[]; formdata?: PmKV[]; options?: { raw?: { language?: string } } };
  auth?: PmAuth | null;
  description?: string | { content?: string };
}
interface PmItem {
  name?: string;
  description?: string | { content?: string };
  item?: PmItem[];
  request?: PmRequest | string;
  event?: PmEvent[];
  auth?: PmAuth | null;
}
export interface PostmanCollection {
  info: { name: string; description?: string | { content?: string }; schema: string; _postman_id?: string };
  item: PmItem[];
  variable?: PmKV[];
  auth?: PmAuth | null;
  event?: PmEvent[];
}
export interface PostmanEnvironment {
  id?: string;
  name: string;
  values: { key: string; value: string; enabled?: boolean; type?: string }[];
  _postman_variable_scope?: string;
}

export function isPostmanCollection(data: unknown): data is PostmanCollection {
  const d = data as PostmanCollection;
  return typeof d?.info?.schema === "string" && d.info.schema.includes("getpostman.com") && Array.isArray(d.item);
}

export function isPostmanEnvironment(data: unknown): data is PostmanEnvironment {
  const d = data as PostmanEnvironment;
  return Array.isArray(d?.values) && typeof d?.name === "string" && !("info" in (d as object));
}

/* ---------- Import ---------- */

const text = (d: string | { content?: string } | undefined) => (typeof d === "string" ? d : d?.content);

const toKV = (list: PmKV[] | string | undefined): KeyValue[] =>
  Array.isArray(list) ? list.map((h) => ({ ...keyValue(h.key, h.value ?? "", !h.disabled), description: h.description })) : [];

function authParams(auth: PmAuth, type: string): Record<string, string> {
  const raw = auth[type];
  // v2.1 uses [{key, value}], v2.0 uses a plain object.
  if (Array.isArray(raw)) return Object.fromEntries(raw.map((kv) => [kv.key, String(kv.value ?? "")]));
  if (raw && typeof raw === "object") return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")]));
  return {};
}

function importAuth(auth: PmAuth | null | undefined, missing: Auth): Auth {
  if (auth === undefined) return missing;
  if (auth === null) return { type: "none" };
  const p = authParams(auth, auth.type);
  switch (auth.type) {
    case "noauth":
      return { type: "none" };
    case "bearer":
      return { type: "bearer", token: p.token ?? "" };
    case "basic":
      return { type: "basic", username: p.username ?? "", password: p.password ?? "" };
    case "apikey":
      return { type: "apikey", key: p.key ?? "", value: p.value ?? "", in: p.in === "query" ? "query" : "header" };
    default:
      // oauth2, digest, awsv4, ... not supported yet: fall back to inherit and keep going.
      return missing;
  }
}

function importScripts(events: PmEvent[] | undefined): Scripts {
  const scripts = emptyScripts();
  for (const e of events ?? []) {
    const exec = e.script?.exec;
    const code = Array.isArray(exec) ? exec.join("\n") : (exec ?? "");
    if (e.listen === "prerequest") scripts.preRequest = code;
    if (e.listen === "test") scripts.test = code;
  }
  return scripts;
}

function importUrl(url: string | PmUrl | undefined): { url: string; params: KeyValue[] } {
  if (!url) return { url: "", params: [] };
  if (typeof url === "string") {
    const { base, params } = splitUrl(url);
    return { url: base, params };
  }
  const raw =
    url.raw ??
    `${url.protocol ? `${url.protocol}://` : ""}${[url.host ?? []].flat().join(".")}${url.port ? `:${url.port}` : ""}/${[url.path ?? []].flat().join("/")}`;
  const { base, params } = splitUrl(raw);
  // The structured query list also carries disabled params, prefer it.
  return { url: base, params: url.query ? toKV(url.query) : params };
}

function importBody(body: PmRequest["body"]): RequestBody {
  const empty: RequestBody = { mode: "none", raw: "", form: [] };
  if (!body?.mode) return empty;
  switch (body.mode) {
    case "raw": {
      const isJson = body.options?.raw?.language === "json" || /^\s*[[{]/.test(body.raw ?? "");
      return { ...empty, mode: isJson ? "json" : "raw", raw: body.raw ?? "" };
    }
    case "urlencoded":
      return { ...empty, mode: "form-urlencoded", form: toKV(body.urlencoded) };
    case "formdata":
      // File fields are kept as text placeholders until file uploads are supported.
      return { ...empty, mode: "form-data", form: toKV(body.formdata) };
    default:
      return empty;
  }
}

function importItem(item: PmItem): Item {
  if (Array.isArray(item.item)) {
    const folder: Folder = {
      kind: "folder",
      id: newId(),
      name: item.name ?? "Folder",
      description: text(item.description),
      items: item.item.map(importItem),
      auth: importAuth(item.auth, { type: "inherit" }),
      scripts: importScripts(item.event),
    };
    return folder;
  }
  const req: PmRequest = typeof item.request === "string" ? { url: item.request } : (item.request ?? {});
  const method = (req.method ?? "GET").toUpperCase() as HttpMethod;
  const { url, params } = importUrl(req.url);
  const request: RequestItem = {
    kind: "request",
    id: newId(),
    name: item.name ?? url,
    description: text(req.description) ?? text(item.description),
    method: HTTP_METHODS.includes(method) ? method : "GET",
    url,
    params,
    headers: toKV(req.header),
    body: importBody(req.body),
    auth: importAuth(req.auth, { type: "inherit" }),
    scripts: importScripts(item.event),
  };
  return request;
}

export function importPostmanCollection(data: PostmanCollection): Collection {
  return {
    id: newId(),
    name: data.info.name,
    description: text(data.info.description),
    items: data.item.map(importItem),
    variables: (data.variable ?? []).map((v) => variable(v.key, String(v.value ?? ""), { enabled: !v.disabled, secret: v.type === "secret" })),
    auth: importAuth(data.auth, { type: "none" }),
    scripts: importScripts(data.event),
  };
}

export function importPostmanEnvironment(data: PostmanEnvironment): Environment {
  return {
    id: newId(),
    name: data.name,
    variables: data.values.map((v) =>
      variable(v.key, v.value ?? "", { enabled: v.enabled !== false, secret: v.type === "secret" }),
    ),
  };
}

/* ---------- Export ---------- */

const fromKV = (list: KeyValue[]): PmKV[] =>
  list.map((kv) => ({ key: kv.key, value: kv.value, ...(kv.enabled ? {} : { disabled: true }), ...(kv.description ? { description: kv.description } : {}) }));

function exportAuth(auth: Auth): PmAuth | undefined {
  const kv = (o: Record<string, string>) => Object.entries(o).map(([key, value]) => ({ key, value, type: "string" }));
  switch (auth.type) {
    case "inherit":
      return undefined;
    case "none":
      return { type: "noauth" };
    case "bearer":
      return { type: "bearer", bearer: kv({ token: auth.token }) };
    case "basic":
      return { type: "basic", basic: kv({ username: auth.username, password: auth.password }) };
    case "apikey":
      return { type: "apikey", apikey: kv({ key: auth.key, value: auth.value, in: auth.in }) };
  }
}

function exportScripts(s: Scripts): PmEvent[] | undefined {
  const events: PmEvent[] = [];
  if (s.preRequest) events.push({ listen: "prerequest", script: { type: "text/javascript", exec: s.preRequest.split("\n") } });
  if (s.test) events.push({ listen: "test", script: { type: "text/javascript", exec: s.test.split("\n") } });
  return events.length ? events : undefined;
}

function exportBody(body: RequestBody): PmRequest["body"] {
  switch (body.mode) {
    case "none":
      return undefined;
    case "json":
      return { mode: "raw", raw: body.raw, options: { raw: { language: "json" } } };
    case "raw":
      return { mode: "raw", raw: body.raw };
    case "form-urlencoded":
      return { mode: "urlencoded", urlencoded: fromKV(body.form) };
    case "form-data":
      return { mode: "formdata", formdata: fromKV(body.form).map((f) => ({ ...f, type: "text" })) };
  }
}

function exportItem(item: Item): PmItem {
  if (item.kind === "folder") {
    return {
      name: item.name,
      description: item.description,
      item: item.items.map(exportItem),
      auth: exportAuth(item.auth),
      event: exportScripts(item.scripts),
    };
  }
  const enabledQuery = item.params.filter((p) => p.enabled && p.key);
  const raw = enabledQuery.length
    ? `${item.url}?${enabledQuery.map((p) => `${p.key}=${p.value}`).join("&")}`
    : item.url;
  return {
    name: item.name,
    event: exportScripts(item.scripts),
    request: {
      method: item.method,
      header: fromKV(item.headers),
      url: { raw, ...(item.params.length ? { query: fromKV(item.params) } : {}) },
      body: exportBody(item.body),
      auth: exportAuth(item.auth),
      description: item.description,
    },
  };
}

/** Exports as Postman v2.1. Secret and device-local variable values are never exported. */
export function exportPostmanCollection(c: Collection): PostmanCollection {
  return {
    info: {
      _postman_id: c.id,
      name: c.name,
      description: c.description,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: c.items.map(exportItem),
    variable: sanitizeVariables(c.variables).map((v) => ({
      key: v.key,
      value: v.value,
      ...(v.enabled ? {} : { disabled: true }),
      ...(v.secret ? { type: "secret" } : {}),
    })),
    auth: exportAuth(c.auth),
    event: exportScripts(c.scripts),
  };
}

export function exportPostmanEnvironment(env: Environment): PostmanEnvironment {
  return {
    id: env.id,
    name: env.name,
    values: sanitizeVariables(env.variables).map((v: Variable) => ({
      key: v.key,
      value: v.value,
      enabled: v.enabled,
      type: v.secret ? "secret" : "default",
    })),
    _postman_variable_scope: "environment",
  };
}
