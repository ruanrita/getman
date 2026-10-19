import type {
  Auth,
  Collection,
  Environment,
  Folder,
  HttpMethod,
  KeyValue,
  RequestItem,
  Scripts,
  Variable,
  Workspace,
} from "./model";

export function newId(): string {
  return crypto.randomUUID();
}

export const emptyScripts = (): Scripts => ({ preRequest: "", test: "" });

export function keyValue(key = "", value = "", enabled = true): KeyValue {
  return { id: newId(), key, value, enabled };
}

export function variable(key = "", value = "", opts: Partial<Variable> = {}): Variable {
  return { id: newId(), key, value, enabled: true, secret: false, ...opts };
}

export function newRequest(name = "New request", method: HttpMethod = "GET", url = ""): RequestItem {
  return {
    kind: "request",
    id: newId(),
    name,
    method,
    url,
    params: [],
    headers: [],
    body: { mode: "none", raw: "", form: [] },
    auth: { type: "inherit" },
    scripts: emptyScripts(),
  };
}

export function newFolder(name = "New folder", auth: Auth = { type: "inherit" }): Folder {
  return { kind: "folder", id: newId(), name, items: [], auth, scripts: emptyScripts() };
}

export function newCollection(name = "New collection"): Collection {
  return { id: newId(), name, items: [], variables: [], auth: { type: "none" }, scripts: emptyScripts() };
}

export function newEnvironment(name = "New environment"): Environment {
  return { id: newId(), name, variables: [] };
}

export function newWorkspace(name: string, owner: { userId: string; email: string }): Workspace {
  return {
    id: newId(),
    name,
    storage: { kind: "local" },
    members: [{ ...owner, role: "owner" }],
    collections: [],
    environments: [],
    globals: [],
  };
}
