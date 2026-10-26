import { describe, expect, it } from "vitest";
import { flattenRequests, prepareRequest, type Folder, type RequestItem } from "@getman/core";
import {
  exportCurl,
  exportGetman,
  exportPostmanCollection,
  exportPostmanEnvironment,
  importAny,
  importCurl,
  importPostmanCollection,
  tokenize,
  type PostmanCollection,
} from "../src";

const postman: PostmanCollection = {
  info: { name: "Demo", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
  variable: [{ key: "base", value: "https://api.test" }],
  event: [{ listen: "prerequest", script: { exec: ["console.log('collection')"] } }],
  item: [
    {
      name: "Users",
      item: [
        {
          name: "Login",
          event: [{ listen: "test", script: { exec: ["const t = pm.response.json().token;", "pm.environment.set('token', t);"] } }],
          request: {
            method: "POST",
            header: [{ key: "X-A", value: "1" }, { key: "X-Off", value: "0", disabled: true }],
            url: { raw: "{{base}}/login?debug=1", query: [{ key: "debug", value: "1" }, { key: "off", value: "x", disabled: true }] },
            body: { mode: "raw", raw: '{"user":"a"}', options: { raw: { language: "json" } } },
            auth: { type: "noauth" },
          },
        },
        { name: "List", request: { method: "GET", url: "{{base}}/users?page=1" } },
      ],
    },
  ],
};

describe("postman", () => {
  it("imports a v2.1 collection", () => {
    const c = importPostmanCollection(postman);
    expect(c.auth).toEqual({ type: "bearer", token: "{{token}}" });
    expect(c.scripts.preRequest).toBe("console.log('collection')");
    const folder = c.items[0] as Folder;
    const login = folder.items[0] as RequestItem;
    expect(login.url).toBe("{{base}}/login");
    expect(login.params.map((p) => [p.key, p.enabled])).toEqual([
      ["debug", true],
      ["off", false],
    ]);
    expect(login.headers[1]!.enabled).toBe(false);
    expect(login.body.mode).toBe("json");
    expect(login.auth).toEqual({ type: "none" });
    expect(login.scripts.test).toContain("pm.environment.set");
    const list = folder.items[1] as RequestItem;
    expect(list.auth).toEqual({ type: "inherit" });
    expect(list.params[0]!.key).toBe("page");
  });

  it("imports v2.0 object-style auth", () => {
    const c = importPostmanCollection({
      ...postman,
      info: { ...postman.info, schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json" },
      auth: { type: "basic", basic: { username: "u", password: "p" } },
    });
    expect(c.auth).toEqual({ type: "basic", username: "u", password: "p" });
  });

  it("round-trips through export", () => {
    const once = importPostmanCollection(postman);
    const twice = importPostmanCollection(exportPostmanCollection(once));
    const strip = (r: RequestItem) => ({ ...r, id: "", params: r.params.map((p) => ({ ...p, id: "" })), headers: r.headers.map((h) => ({ ...h, id: "" })) });
    expect(flattenRequests(twice.items).map(strip)).toEqual(flattenRequests(once.items).map(strip));
    expect(twice.auth).toEqual(once.auth);
    expect(twice.scripts).toEqual(once.scripts);
  });

  it("never exports secret values", () => {
    const env = importAny(
      JSON.stringify({
        name: "Prod",
        values: [
          { key: "host", value: "prod", enabled: true },
          { key: "password", value: "s3cret", enabled: true, type: "secret" },
        ],
      }),
    ).environments[0]!;
    expect(env.variables[1]!.secret).toBe(true);
    const out = exportPostmanEnvironment(env);
    expect(out.values[1]).toMatchObject({ key: "password", value: "", type: "secret" });
    expect(exportGetman({ environments: [env] })).not.toContain("s3cret");
  });
});

describe("curl", () => {
  it("tokenizes quotes and continuations", () => {
    expect(tokenize(`curl -H 'A: b c' \\\n "x\\"y" $'z'`)).toEqual(["curl", "-H", "A: b c", 'x"y', "z"]);
  });

  it("imports a JSON POST", () => {
    const r = importCurl(`curl 'https://api.test/users?x=1' -H 'Content-Type: application/json' --data-raw '{"a":1}'`);
    expect(r.method).toBe("POST");
    expect(r.url).toBe("https://api.test/users");
    expect(r.params[0]).toMatchObject({ key: "x", value: "1" });
    expect(r.body.mode).toBe("json");
    expect(JSON.parse(r.body.raw)).toEqual({ a: 1 });
  });

  it("imports form data, basic auth and explicit method", () => {
    const r = importCurl(`curl -X PUT -u user:pass --url https://x.io -d a=1 -d b=two`);
    expect(r.method).toBe("PUT");
    expect(r.auth).toEqual({ type: "basic", username: "user", password: "pass" });
    expect(r.body.mode).toBe("form-urlencoded");
    expect(r.body.form.map((f) => [f.key, f.value])).toEqual([
      ["a", "1"],
      ["b", "two"],
    ]);
  });

  it("round-trips through export", () => {
    const original = importCurl(`curl -X POST 'https://x.io/a' -H "X-Q: it's" --data-raw '{"a":1}'`);
    const again = importCurl(exportCurl(prepareRequest(original, original.auth, [])));
    expect(again.method).toBe("POST");
    expect(again.headers.find((h) => h.key === "X-Q")!.value).toBe("it's");
    expect(JSON.parse(again.body.raw)).toEqual({ a: 1 });
  });
});

describe("openapi", () => {
  it("imports paths, tags, params, bodies and security", () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "Pets" },
      servers: [{ url: "https://{env}.pets.io/v1", variables: { env: { default: "api" } } }],
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        schemas: { Pet: { type: "object", properties: { name: { type: "string", example: "Rex" }, age: { type: "integer" } } } },
      },
      paths: {
        "/pets/{id}": {
          parameters: [{ name: "id", in: "path", required: true }],
          get: { tags: ["pets"], summary: "Get pet", parameters: [{ name: "fields", in: "query", schema: { example: "name" } }] },
          put: {
            tags: ["pets"],
            operationId: "updatePet",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } },
          },
        },
        "/health": { get: {} },
      },
    };
    const r = importAny(JSON.stringify(spec));
    expect(r.format).toBe("openapi");
    const c = r.collections[0]!;
    expect(c.variables.find((v) => v.key === "baseUrl")!.value).toBe("https://api.pets.io/v1");
    expect(c.auth).toEqual({ type: "bearer", token: "{{token}}" });
    const pets = c.items[0] as Folder;
    expect(pets.name).toBe("pets");
    const get = pets.items[0] as RequestItem;
    expect(get.url).toBe("{{baseUrl}}/pets/{{id}}");
    expect(get.params[0]).toMatchObject({ key: "fields", value: "name" });
    const put = pets.items[1] as RequestItem;
    expect(put.name).toBe("updatePet");
    expect(JSON.parse(put.body.raw)).toEqual({ name: "Rex", age: 0 });
    expect((c.items[1] as RequestItem).name).toBe("GET /health");
  });

  it("reads YAML", () => {
    const r = importAny("swagger: '2.0'\ninfo: {title: Old}\nhost: old.io\nbasePath: /api\npaths:\n  /a:\n    get: {summary: A}\n");
    expect(r.collections[0]!.variables[0]!.value).toBe("https://old.io/api");
  });
});

describe("importAny", () => {
  it("round-trips the native format", () => {
    const c = importPostmanCollection(postman);
    const r = importAny(exportGetman({ collections: [c] }));
    expect(r.format).toBe("getman");
    expect(r.collections[0]!.name).toBe("Demo");
  });

  it("rejects unknown formats with a helpful message", () => {
    expect(() => importAny('{"hello":1}')).toThrow(/Unsupported format/);
  });
});

describe("getman workspace files", () => {
  it("round-trips workspace name and globals, without secrets", () => {
    const c = importPostmanCollection(postman);
    const text = exportGetman({ workspaceName: "Team", globals: [{ id: "g", key: "base", value: "x", enabled: true, secret: false }, { id: "s", key: "pw", value: "hidden", enabled: true, secret: true }], collections: [c] });
    expect(text).not.toContain("hidden");
    const r = importAny(text);
    expect(r.workspaceName).toBe("Team");
    expect(r.globals?.map((v) => `${v.key}=${v.value}`)).toEqual(["base=x", "pw="]);
  });
});
