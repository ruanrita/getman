import { describe, expect, it } from "vitest";
import { keyValue, newCollection, newEnvironment, newFolder, newRequest, variable, type Folder, type RequestItem } from "@getman/core";
import { diffFiles, filesToWorkspace, slugify, workspaceToFiles, type FolderWorkspace } from "../src";

function sample(): FolderWorkspace {
  const col = newCollection("Payments API");
  col.auth = { type: "bearer", token: "{{token}}" };
  col.variables.push(variable("base", "https://api.test"), variable("token", "s3cret", { secret: true }), variable("host", "h", { localValue: "mine" }));
  col.scripts.preRequest = "console.log('collection')";

  const auth = newFolder("Auth / Login");
  const login = newRequest("Login", "POST", "{{base}}/login");
  login.body = { mode: "json", raw: '{\n  "user": "a"\n}', form: [] };
  login.scripts.test = 'pm.test("ok", () => pm.response.to.have.status(200));\npm.environment.set("token", pm.response.json().token);';
  login.headers.push({ ...keyValue("X-Off", "1", false), description: "disabled header" });
  auth.items.push(login);

  const list = newRequest("List payments", "GET", "{{base}}/payments");
  list.params.push(keyValue("page", "1"));
  const listDup = newRequest("List payments", "GET", "{{base}}/payments?v=2");
  const named = newRequest("Folder", "GET", "{{base}}/folder");
  const form = newRequest("Upload", "POST", "{{base}}/up");
  form.body = { mode: "form-urlencoded", raw: "", form: [keyValue("a", "1")] };
  form.auth = { type: "basic", username: "u", password: "{{pw}}" };
  col.items.push(auth, list, listDup, named, form);

  const env = newEnvironment("Dev");
  env.variables.push(variable("token", "", { localValue: "local-token" }), variable("apiKey", "key-123", { secret: true }));
  return { name: "Team", globals: [variable("g", "1")], collections: [col], environments: [env] };
}


describe("folder format", () => {
  it("writes one file per request with readable, stable names", () => {
    const files = workspaceToFiles(sample());
    expect(Object.keys(files).sort()).toEqual([
      "collections/payments-api/auth-login/folder.yaml",
      "collections/payments-api/auth-login/login.yaml",
      "collections/payments-api/collection.yaml",
      "collections/payments-api/folder-2.yaml",
      "collections/payments-api/list-payments-2.yaml",
      "collections/payments-api/list-payments.yaml",
      "collections/payments-api/upload.yaml",
      "environments/dev.yaml",
      "workspace.yaml",
    ]);
    const login = files["collections/payments-api/auth-login/login.yaml"]!;
    expect(login).toContain("test: |-\n");
    expect(login).toContain("method: POST");
    expect(login).not.toContain("params:"); // empty fields omitted
    expect(files["collections/payments-api/list-payments.yaml"]).not.toMatch(/auth:|scripts:|body:/);
  });

  it("never writes secret or local values", () => {
    const all = Object.values(workspaceToFiles(sample())).join("\n");
    expect(all).not.toMatch(/s3cret|key-123|local-token|mine/);
    expect(all).toContain("secret: true");
  });

  it("round-trips everything except secrets and local values", () => {
    const ws = sample();
    const back = filesToWorkspace(workspaceToFiles(ws));
    const col = back.collections[0]!;
    expect(col.name).toBe("Payments API");
    expect(col.id).toBe(ws.collections[0]!.id);
    expect(col.auth).toEqual({ type: "bearer", token: "{{token}}" });
    expect(col.items.map((i) => i.name)).toEqual(["Auth / Login", "List payments", "List payments", "Folder", "Upload"]);
    const login = (col.items[0] as Folder).items[0] as RequestItem;
    const original = ((ws.collections[0]!.items[0] as Folder).items[0] as RequestItem);
    expect(login.id).toBe(original.id);
    expect(login.body).toEqual(original.body);
    expect(login.scripts).toEqual(original.scripts);
    expect(login.headers.map(({ id: _i, ...h }) => h)).toEqual([{ key: "X-Off", value: "1", enabled: false, description: "disabled header" }]);
    expect((col.items[4] as RequestItem).auth).toEqual({ type: "basic", username: "u", password: "{{pw}}" });
    expect((col.items[4] as RequestItem).body.form[0]).toMatchObject({ key: "a", value: "1" });
    expect(col.variables.find((v) => v.key === "token")).toMatchObject({ value: "", secret: true });
    expect(back.environments[0]!.variables.map((v) => v.key)).toEqual(["token", "apiKey"]);
    expect(back.globals[0]).toMatchObject({ key: "g", value: "1" });
    // Writing the result again produces identical files: no churn in Git.
    expect(workspaceToFiles(back)).toEqual(workspaceToFiles(ws));
  });

  it("keeps saved order and appends files added by hand", () => {
    const files = workspaceToFiles(sample());
    files["collections/payments-api/aaa-handmade.yaml"] = "name: Handmade\nmethod: DELETE\nurl: /x\n";
    const names = filesToWorkspace(files).collections[0]!.items.map((i) => i.name);
    expect(names.at(-1)).toBe("Handmade");
    expect(names[0]).toBe("Auth / Login");
  });

  it("reports merge conflicts and bad YAML with the file name", () => {
    const files = workspaceToFiles(sample());
    files["collections/payments-api/upload.yaml"] = "<<<<<<< HEAD\nname: A\n=======\nname: B\n>>>>>>> main\n";
    expect(() => filesToWorkspace(files)).toThrow(/upload\.yaml: has unresolved Git merge conflict/);
    files["collections/payments-api/upload.yaml"] = "name: [unclosed";
    expect(() => filesToWorkspace(files)).toThrow(/upload\.yaml: invalid YAML/);
    expect(() => filesToWorkspace({})).toThrow(/no .getman\/workspace.yaml/);
    expect(() => filesToWorkspace({ "workspace.yaml": "getman: 99\nname: x\n" })).toThrow(/newer Getman/);
  });

  it("computes minimal file operations", () => {
    const ws = sample();
    const before = workspaceToFiles(ws);
    (ws.collections[0]!.items[1] as RequestItem).url = "{{base}}/v2/payments";
    ws.collections[0]!.items.splice(3, 1); // delete "Folder"
    const ops = diffFiles(before, workspaceToFiles(ws));
    expect(ops.map((o) => [o.path, o.content === null ? "delete" : "write"])).toEqual([
      ["collections/payments-api/list-payments.yaml", "write"],
      ["collections/payments-api/collection.yaml", "write"],
      ["collections/payments-api/folder-2.yaml", "delete"],
    ]);
  });

  it("slugifies names", () => {
    expect(slugify("Pagamentos & Cobrança!")).toBe("pagamentos-cobranca");
    expect(slugify("   ")).toBe("untitled");
  });
});
