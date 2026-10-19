import { describe, expect, it } from "vitest";
import type { HttpResponse } from "@getman/core";
import { runScript, type ScriptContext } from "../src";

const response: HttpResponse = {
  status: 200,
  statusText: "OK",
  headers: [["Content-Type", "application/json"]],
  body: JSON.stringify({ token: "abc", user: { id: 7 } }),
  timeMs: 42,
  sizeBytes: 40,
};

const ctx = (over: Partial<ScriptContext> = {}): ScriptContext => ({
  event: "test",
  requestName: "Login",
  request: { method: "GET", url: "https://x.io", headers: [] },
  response,
  variables: { environment: { host: "dev" }, collection: { v: "1" }, globals: {}, runtime: {} },
  ...over,
});

describe("pm api", () => {
  it("extracts a token into the environment (the classic chaining case)", async () => {
    const r = await runScript(`pm.environment.set("token", pm.response.json().token);`, ctx());
    expect(r.error).toBeUndefined();
    expect(r.changes).toEqual([{ scope: "environment", key: "token", value: "abc" }]);
  });

  it("runs tests with pm.expect and pm.response.to", async () => {
    const r = await runScript(
      `
      pm.test("status 200", () => pm.response.to.have.status(200));
      pm.test("is ok", () => { pm.response.to.be.ok; });
      pm.test("has header", () => pm.response.to.have.header("content-type"));
      pm.test("user id", () => pm.expect(pm.response.json().user.id).to.eql(7));
      pm.test("fails", () => pm.expect(1).to.equal(2));
      pm.test("async", async () => { await Promise.resolve(); pm.expect(true).to.be.true; });
    `,
      ctx(),
    );
    expect(r.tests.map((t) => [t.name, t.passed])).toEqual([
      ["status 200", true],
      ["is ok", true],
      ["has header", true],
      ["user id", true],
      ["fails", false],
      ["async", true],
    ]);
    expect(r.tests[4]!.error).toContain("expected 1 to equal 2");
  });

  it("resolves pm.variables through scopes and sets runtime vars", async () => {
    const r = await runScript(
      `pm.variables.set("x", 5); console.log(pm.variables.get("host"), pm.variables.get("v"), pm.variables.get("x")); console.log(pm.variables.replaceIn("{{host}}/{{nope}}"));`,
      ctx(),
    );
    expect(r.logs.map((l) => l.message)).toEqual(["dev 1 5", "dev/{{nope}}"]);
    expect(r.changes).toContainEqual({ scope: "runtime", key: "x", value: "5" });
  });

  it("lets pre-request scripts edit headers", async () => {
    const r = await runScript(
      `pm.request.headers.add({ key: "X-Ts", value: "1" }); pm.request.headers.upsert({ key: "x-ts", value: "2" });`,
      ctx({ event: "prerequest", response: undefined }),
    );
    expect(r.request.headers).toEqual([["x-ts", "2"]]);
  });

  it("supports the legacy postman / tests API", async () => {
    const r = await runScript(
      `postman.setEnvironmentVariable("a", "b"); tests["code is 200"] = responseCode.code === 200; tests["body"] = JSON.parse(responseBody).token === "abc";`,
      ctx(),
    );
    expect(r.changes).toContainEqual({ scope: "environment", key: "a", value: "b" });
    expect(r.tests).toEqual([
      { name: "code is 200", passed: true },
      { name: "body", passed: true },
    ]);
  });

  it("supports pm.sendRequest with promise and callback", async () => {
    const send = async () => ({ ...response, body: '{"n":1}' });
    const r = await runScript(
      `
      const res = await pm.sendRequest("https://other");
      pm.environment.set("n", res.json().n);
      pm.sendRequest({ url: "https://other", method: "POST" }, (err, res2) => pm.globals.set("cb", res2.code));
    `,
      ctx({ send }),
    );
    expect(r.error).toBeUndefined();
    expect(r.changes).toEqual([
      { scope: "environment", key: "n", value: "1" },
      { scope: "globals", key: "cb", value: "200" },
    ]);
  });

  it("reports runtime errors without throwing", async () => {
    const r = await runScript(`undefinedFn()`, ctx());
    expect(r.error).toMatch(/undefinedFn/);
  });
});
