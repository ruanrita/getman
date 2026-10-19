import { describe, expect, it } from "vitest";
import {
  can,
  canChangeRole,
  effectiveAuth,
  findItemPath,
  joinUrl,
  keyValue,
  newCollection,
  newFolder,
  newRequest,
  newWorkspace,
  prepareRequest,
  resolve,
  sanitizeVariables,
  scopeChain,
  splitUrl,
  transferOwnership,
  unresolvedVariables,
  variable,
} from "../src";

describe("variables", () => {
  const scopes = scopeChain({
    runtime: new Map([["token", "runtime-token"]]),
    environment: [variable("host", "api.dev"), variable("token", "env-token"), variable("url", "https://{{host}}/v1")],
    collection: [variable("host", "api.collection"), variable("version", "1")],
    globals: [variable("version", "global")],
  });

  it("applies precedence runtime > environment > collection > globals", () => {
    expect(resolve("{{token}} {{host}} {{version}}", scopes)).toBe("runtime-token api.dev 1");
  });

  it("resolves nested references", () => {
    expect(resolve("{{url}}/users", scopes)).toBe("https://api.dev/v1/users");
  });

  it("keeps unknown variables and reports them", () => {
    expect(resolve("{{missing}}", scopes)).toBe("{{missing}}");
    expect(unresolvedVariables("{{host}}/{{missing}}", scopes)).toEqual(["missing"]);
  });

  it("prefers the device-local value", () => {
    const s = scopeChain({ environment: [variable("k", "shared", { localValue: "mine" })] });
    expect(resolve("{{k}}", s)).toBe("mine");
  });

  it("ignores disabled variables", () => {
    const s = scopeChain({ environment: [variable("k", "v", { enabled: false })] });
    expect(resolve("{{k}}", s)).toBe("{{k}}");
  });

  it("supports dynamic variables", () => {
    expect(resolve("{{$guid}}", [])).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(resolve("{{$timestamp}}", []))).toBeGreaterThan(1_600_000_000);
  });

  it("sanitizes secrets and local values before leaving the device", () => {
    const out = sanitizeVariables([
      variable("public", "a", { localValue: "local" }),
      variable("password", "s3cret", { secret: true }),
    ]);
    expect(out[0]).not.toHaveProperty("localValue");
    expect(out[0]!.value).toBe("a");
    expect(out[1]!.value).toBe("");
  });
});

describe("permissions", () => {
  const owner = { userId: "o", email: "o@x", role: "owner" as const };
  const admin = { userId: "a", email: "a@x", role: "admin" as const };
  const editor = { userId: "e", email: "e@x", role: "editor" as const };

  it("checks role hierarchy", () => {
    expect(can("viewer", "requests.send")).toBe(true);
    expect(can("viewer", "collections.write")).toBe(false);
    expect(can("editor", "collections.write")).toBe(true);
    expect(can("admin", "members.manage")).toBe(true);
    expect(can("admin", "workspace.delete")).toBe(false);
    expect(can("owner", "workspace.delete")).toBe(true);
  });

  it("lets admins grant admin but not touch other admins or the owner", () => {
    expect(canChangeRole(admin, editor, "admin")).toBe(true);
    expect(canChangeRole(admin, { ...admin, userId: "a2" }, "viewer")).toBe(false);
    expect(canChangeRole(admin, owner, "viewer")).toBe(false);
    expect(canChangeRole(owner, admin, "editor")).toBe(true);
    expect(canChangeRole(owner, editor, "owner")).toBe(false);
  });

  it("transfers ownership and demotes previous owner to admin", () => {
    const ws = newWorkspace("w", { userId: "o", email: "o@x" });
    ws.members.push(editor);
    const out = transferOwnership(ws, "o", "e");
    expect(out.members.find((m) => m.userId === "e")!.role).toBe("owner");
    expect(out.members.find((m) => m.userId === "o")!.role).toBe("admin");
    expect(() => transferOwnership(ws, "e", "o")).toThrow();
  });
});

describe("requests", () => {
  it("splits and joins urls keeping {{vars}} unencoded", () => {
    const { base, params } = splitUrl("https://x.io/a?q=hello%20world&id={{id}}");
    expect(base).toBe("https://x.io/a");
    expect(params.map((p) => [p.key, p.value])).toEqual([
      ["q", "hello world"],
      ["id", "{{id}}"],
    ]);
    expect(joinUrl(base, params)).toBe("https://x.io/a?q=hello%20world&id={{id}}");
  });

  it("inherits auth through folders", () => {
    const col = newCollection();
    col.auth = { type: "bearer", token: "{{token}}" };
    const folder = newFolder("f");
    const req = newRequest("r");
    folder.items.push(req);
    col.items.push(folder);
    const path = findItemPath(col, req.id)!;
    expect(effectiveAuth(req, path.ancestors)).toEqual({ type: "bearer", token: "{{token}}" });
  });

  it("prepares a request with auth, params and json body", () => {
    const req = newRequest("r", "POST", "{{base}}/users");
    req.params.push(keyValue("page", "{{page}}"), keyValue("off", "x", false));
    req.headers.push(keyValue("X-Trace", "{{$guid}}"));
    req.body = { mode: "json", raw: '{"name":"{{name}}"}', form: [] };
    const scopes = scopeChain({
      environment: [variable("base", "https://api.test"), variable("page", "2"), variable("name", "Ana"), variable("t", "abc")],
    });
    const out = prepareRequest(req, { type: "bearer", token: "{{t}}" }, scopes);
    expect(out.url).toBe("https://api.test/users?page=2");
    expect(out.headers).toContainEqual(["Authorization", "Bearer abc"]);
    expect(out.headers).toContainEqual(["Content-Type", "application/json"]);
    expect(out.body).toEqual({ kind: "text", text: '{"name":"Ana"}', contentType: "application/json" });
  });

  it("does not send a body on GET", () => {
    const req = newRequest("r", "GET", "https://x");
    req.body = { mode: "json", raw: "{}", form: [] };
    expect(prepareRequest(req, { type: "none" }, []).body).toBeUndefined();
  });

  it("encodes basic auth as utf-8", () => {
    const out = prepareRequest(newRequest(), { type: "basic", username: "joão", password: "p" }, []);
    expect(out.headers[0]![1]).toBe(`Basic ${Buffer.from("joão:p").toString("base64")}`);
  });
});
