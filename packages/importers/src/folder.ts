/**
 * Workspace <-> folder of YAML files, for Git storage.
 *
 *   .getman/
 *     workspace.yaml                        name, globals
 *     environments/<env>.yaml
 *     collections/<collection>/collection.yaml   settings + child order
 *     collections/<collection>/<request>.yaml
 *     collections/<collection>/<folder>/folder.yaml
 *     collections/<collection>/<folder>/<request>.yaml
 *
 * One file per request keeps diffs and merge conflicts small. Empty/default
 * fields are omitted so files stay short. Secret and local values are never
 * written (sanitizeVariables). Paths are relative to `.getman/`.
 */
import YAML from "yaml";
import {
  emptyScripts,
  keyValue,
  newId,
  sanitizeVariables,
  variable,
  type Auth,
  type Collection,
  type Environment,
  type Folder,
  type HttpMethod,
  type Item,
  type KeyValue,
  type RequestBody,
  type RequestItem,
  type Scripts,
  type Variable,
} from "@getman/core";

export const FOLDER_FORMAT_VERSION = 1;

export interface FolderWorkspace {
  name: string;
  globals: Variable[];
  collections: Collection[];
  environments: Environment[];
}

export class FolderFormatError extends Error {
  constructor(
    message: string,
    public file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

/* ---------- writing ---------- */

export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** Unique, stable names inside one directory: "login", "login-2", … */
function uniqueNamer(reserved: string[] = []) {
  const used = new Set(reserved);
  return (base: string) => {
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
    used.add(name);
    return name;
  };
}

const yaml = (data: unknown) => YAML.stringify(data, { lineWidth: 0 });

const kvOut = (list: KeyValue[]) =>
  list.map((kv) => ({ key: kv.key, value: kv.value, ...(kv.enabled ? {} : { disabled: true }), ...(kv.description ? { description: kv.description } : {}) }));

const varsOut = (vars: Variable[]) =>
  sanitizeVariables(vars).map((v) => ({ key: v.key, value: v.value, ...(v.secret ? { secret: true } : {}), ...(v.enabled ? {} : { disabled: true }) }));

const scriptsOut = (s: Scripts) => (s.preRequest || s.test ? { ...(s.preRequest ? { preRequest: s.preRequest } : {}), ...(s.test ? { test: s.test } : {}) } : undefined);

function requestOut(r: RequestItem) {
  return {
    id: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    method: r.method,
    url: r.url,
    ...(r.params.length ? { params: kvOut(r.params) } : {}),
    ...(r.headers.length ? { headers: kvOut(r.headers) } : {}),
    ...(r.body.mode !== "none"
      ? { body: r.body.mode === "json" || r.body.mode === "raw" ? { mode: r.body.mode, raw: r.body.raw } : { mode: r.body.mode, form: kvOut(r.body.form) } }
      : {}),
    ...(r.auth.type !== "inherit" ? { auth: r.auth } : {}),
    ...(scriptsOut(r.scripts) ? { scripts: scriptsOut(r.scripts) } : {}),
  };
}

function itemsOut(items: Item[], dir: string, files: Record<string, string>): string[] {
  // Names are compared without extension: a request called "Folder" must not become folder.yaml.
  const name = uniqueNamer(["folder", "collection"]);
  return items.map((item) => {
    const base = slugify(item.name);
    if (item.kind === "request") {
      const file = `${name(base)}.yaml`;
      files[`${dir}/${file}`] = yaml(requestOut(item));
      return file;
    }
    const sub = name(base);
    const order = itemsOut(item.items, `${dir}/${sub}`, files);
    files[`${dir}/${sub}/folder.yaml`] = yaml({
      id: item.id,
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(item.auth.type !== "inherit" ? { auth: item.auth } : {}),
      ...(scriptsOut(item.scripts) ? { scripts: scriptsOut(item.scripts) } : {}),
      order,
    });
    return `${sub}/`;
  });
}

/** All files of a workspace, keyed by path relative to `.getman/`. */
export function workspaceToFiles(ws: FolderWorkspace): Record<string, string> {
  const files: Record<string, string> = {};
  files["workspace.yaml"] = yaml({ getman: FOLDER_FORMAT_VERSION, name: ws.name, ...(ws.globals.length ? { globals: varsOut(ws.globals) } : {}) });

  const envName = uniqueNamer();
  for (const env of ws.environments) {
    files[`environments/${envName(slugify(env.name))}.yaml`] = yaml({ id: env.id, name: env.name, variables: varsOut(env.variables) });
  }

  const colName = uniqueNamer();
  for (const c of ws.collections) {
    const dir = `collections/${colName(slugify(c.name))}`;
    const order = itemsOut(c.items, dir, files);
    files[`${dir}/collection.yaml`] = yaml({
      id: c.id,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(c.variables.length ? { variables: varsOut(c.variables) } : {}),
      auth: c.auth,
      ...(scriptsOut(c.scripts) ? { scripts: scriptsOut(c.scripts) } : {}),
      order,
    });
  }
  return files;
}

/* ---------- reading ---------- */

type Json = Record<string, any>;

const CONFLICT = /^(<{7}|={7}|>{7})( |$)/m;

function parse(path: string, text: string): Json {
  if (CONFLICT.test(text)) throw new FolderFormatError("has unresolved Git merge conflict markers. Resolve the conflict with your Git tool, then reload.", path);
  try {
    const data = YAML.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected a YAML mapping");
    return data;
  } catch (e) {
    throw new FolderFormatError(`invalid YAML (${(e as Error).message})`, path);
  }
}

const str = (v: unknown, fallback = "") => (v === undefined || v === null ? fallback : String(v));

const kvIn = (list: unknown): KeyValue[] =>
  Array.isArray(list) ? list.map((x: Json) => ({ ...keyValue(str(x.key), str(x.value), !x.disabled), ...(x.description ? { description: str(x.description) } : {}) })) : [];

const varsIn = (list: unknown): Variable[] =>
  Array.isArray(list) ? list.map((x: Json) => variable(str(x.key), str(x.value), { secret: Boolean(x.secret), enabled: !x.disabled })) : [];

const scriptsIn = (s: Json | undefined): Scripts => ({ ...emptyScripts(), preRequest: str(s?.preRequest), test: str(s?.test) });

function authIn(a: Json | undefined, fallback: Auth): Auth {
  if (!a?.type) return fallback;
  switch (a.type) {
    case "none":
    case "inherit":
      return { type: a.type };
    case "bearer":
      return { type: "bearer", token: str(a.token) };
    case "basic":
      return { type: "basic", username: str(a.username), password: str(a.password) };
    case "apikey":
      return { type: "apikey", key: str(a.key), value: str(a.value), in: a.in === "query" ? "query" : "header" };
    default:
      return fallback;
  }
}

function bodyIn(b: Json | undefined): RequestBody {
  const mode = b?.mode;
  if (mode === "json" || mode === "raw") return { mode, raw: str(b!.raw), form: [] };
  if (mode === "form-urlencoded" || mode === "form-data") return { mode, raw: "", form: kvIn(b!.form) };
  return { mode: "none", raw: "", form: [] };
}

/**
 * Children of a directory in the saved order, then any entries the order does
 * not mention (e.g. a file a teammate added by hand), alphabetically.
 */
function orderedChildren(dir: string, order: unknown, files: Record<string, string>, marker: string): string[] {
  const prefix = `${dir}/`;
  const present = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      if (rest !== marker && /\.ya?ml$/.test(rest)) present.add(rest);
    } else if (files[`${prefix}${rest.slice(0, slash)}/folder.yaml`] !== undefined) {
      present.add(`${rest.slice(0, slash)}/`);
    }
  }
  const listed = (Array.isArray(order) ? order.map(String) : []).filter((e) => present.has(e));
  const extra = [...present].filter((e) => !listed.includes(e)).sort();
  return [...listed, ...extra];
}

function itemsIn(dir: string, order: unknown, files: Record<string, string>, marker: string): Item[] {
  return orderedChildren(dir, order, files, marker).map((entry) => {
    if (entry.endsWith("/")) {
      const sub = `${dir}/${entry.slice(0, -1)}`;
      const meta = parse(`${sub}/folder.yaml`, files[`${sub}/folder.yaml`]!);
      const folder: Folder = {
        kind: "folder",
        id: str(meta.id) || newId(),
        name: str(meta.name, entry.slice(0, -1)),
        ...(meta.description ? { description: str(meta.description) } : {}),
        items: itemsIn(sub, meta.order, files, "folder.yaml"),
        auth: authIn(meta.auth, { type: "inherit" }),
        scripts: scriptsIn(meta.scripts),
      };
      return folder;
    }
    const path = `${dir}/${entry}`;
    const r = parse(path, files[path]!);
    const method = str(r.method, "GET").toUpperCase() as HttpMethod;
    const request: RequestItem = {
      kind: "request",
      id: str(r.id) || newId(),
      name: str(r.name, entry.replace(/\.ya?ml$/, "")),
      ...(r.description ? { description: str(r.description) } : {}),
      method,
      url: str(r.url),
      params: kvIn(r.params),
      headers: kvIn(r.headers),
      body: bodyIn(r.body),
      auth: authIn(r.auth, { type: "inherit" }),
      scripts: scriptsIn(r.scripts),
    };
    return request;
  });
}

/** Rebuilds a workspace from `.getman/` files. Throws FolderFormatError naming the bad file. */
export function filesToWorkspace(files: Record<string, string>): FolderWorkspace {
  if (files["workspace.yaml"] === undefined) throw new FolderFormatError("This folder has no .getman/workspace.yaml");
  const meta = parse("workspace.yaml", files["workspace.yaml"]);
  if (Number(meta.getman) > FOLDER_FORMAT_VERSION) {
    throw new FolderFormatError(`was written by a newer Getman (format ${meta.getman}). Update Getman.`, "workspace.yaml");
  }

  const environments = Object.keys(files)
    .filter((p) => /^environments\/[^/]+\.ya?ml$/.test(p))
    .sort()
    .map((p) => {
      const e = parse(p, files[p]!);
      return { id: str(e.id) || newId(), name: str(e.name, p.slice(13).replace(/\.ya?ml$/, "")), variables: varsIn(e.variables) } satisfies Environment;
    });

  const collectionDirs = [...new Set(Object.keys(files).flatMap((p) => p.match(/^(collections\/[^/]+)\/collection\.ya?ml$/)?.[1] ?? []))].sort();
  const collections = collectionDirs.map((dir) => {
    const path = files[`${dir}/collection.yaml`] !== undefined ? `${dir}/collection.yaml` : `${dir}/collection.yml`;
    const c = parse(path, files[path]!);
    return {
      id: str(c.id) || newId(),
      name: str(c.name, dir.slice(12)),
      ...(c.description ? { description: str(c.description) } : {}),
      items: itemsIn(dir, c.order, files, path.slice(dir.length + 1)),
      variables: varsIn(c.variables),
      auth: authIn(c.auth, { type: "none" }),
      scripts: scriptsIn(c.scripts),
    } satisfies Collection;
  });

  return { name: str(meta.name, "Workspace"), globals: varsIn(meta.globals), collections, environments };
}

/** Files to create, change and delete so `before` becomes `after`. */
export function diffFiles(before: Record<string, string>, after: Record<string, string>): { path: string; content: string | null }[] {
  const ops: { path: string; content: string | null }[] = [];
  for (const [path, content] of Object.entries(after)) if (before[path] !== content) ops.push({ path, content });
  for (const path of Object.keys(before)) if (!(path in after)) ops.push({ path, content: null });
  return ops;
}

/* ---------- readable YAML for comparisons (same shape as the files) ---------- */

/** A request or folder (without children) as YAML. */
export function itemToYaml(item: Item): string {
  if (item.kind === "request") {
    const { id: _id, ...rest } = requestOut(item);
    return yaml(rest);
  }
  return yaml({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    ...(item.auth.type !== "inherit" ? { auth: item.auth } : {}),
    ...(scriptsOut(item.scripts) ? { scripts: scriptsOut(item.scripts) } : {}),
  });
}

/** An environment (or globals) as YAML; secret and local values are never shown. */
export function variablesToYaml(name: string | undefined, vars: Variable[]): string {
  return yaml({ ...(name !== undefined ? { name } : {}), variables: varsOut(vars) });
}

export function collectionSettingsToYaml(c: Omit<Collection, "items">): string {
  return yaml({
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    ...(c.variables.length ? { variables: varsOut(c.variables) } : {}),
    auth: c.auth,
    ...(scriptsOut(c.scripts) ? { scripts: scriptsOut(c.scripts) } : {}),
  });
}
