import { expect } from "chai";
import type { HttpResponse, PreparedRequest } from "@getman/core";

export type VariableScopeName = "environment" | "collection" | "globals" | "runtime";

export interface ScriptVariables {
  environment: Record<string, string>;
  collection: Record<string, string>;
  globals: Record<string, string>;
  runtime: Record<string, string>;
}

export interface ScriptContext {
  event: "prerequest" | "test";
  requestName: string;
  request: PreparedRequest;
  response?: HttpResponse;
  variables: ScriptVariables;
  /** Transport for pm.sendRequest. When omitted, pm.sendRequest throws. */
  send?: (req: PreparedRequest) => Promise<HttpResponse>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface LogEntry {
  level: "log" | "info" | "warn" | "error";
  message: string;
}

export interface VariableChange {
  scope: VariableScopeName;
  key: string;
  /** undefined means the variable was unset. */
  value?: string;
}

export interface ScriptResult {
  tests: TestResult[];
  logs: LogEntry[];
  changes: VariableChange[];
  /** The request after the script ran (pre-request scripts may edit it). */
  request: PreparedRequest;
  error?: string;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs one script with a Postman-compatible `pm` object.
 *
 * This function does NOT sandbox the code. Callers must run it in an isolated
 * context (the desktop app uses a dedicated Web Worker, see worker.ts).
 */
export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptResult> {
  const vars: ScriptVariables = {
    environment: { ...ctx.variables.environment },
    collection: { ...ctx.variables.collection },
    globals: { ...ctx.variables.globals },
    runtime: { ...ctx.variables.runtime },
  };
  const request: PreparedRequest = { ...ctx.request, headers: ctx.request.headers.map(([k, v]) => [k, v]) };
  const tests: TestResult[] = [];
  const logs: LogEntry[] = [];
  const changes: VariableChange[] = [];
  const pendingTests: Promise<void>[] = [];

  const scopeApi = (scope: VariableScopeName) => ({
    get: (key: string) => vars[scope][key],
    has: (key: string) => key in vars[scope],
    set: (key: string, value: unknown) => {
      const v = typeof value === "string" ? value : stringify(value);
      vars[scope][key] = v;
      changes.push({ scope, key, value: v });
    },
    unset: (key: string) => {
      delete vars[scope][key];
      changes.push({ scope, key });
    },
    clear: () => {
      for (const key of Object.keys(vars[scope])) {
        delete vars[scope][key];
        changes.push({ scope, key });
      }
    },
    toObject: () => ({ ...vars[scope] }),
  });

  const headerApi = (headers: [string, string][]) => ({
    get: (name: string) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
    has: (name: string) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase()),
    toObject: () => Object.fromEntries(headers),
    all: () => headers.map(([key, value]) => ({ key, value })),
  });

  const mutableHeaderApi = (headers: [string, string][]) => ({
    ...headerApi(headers),
    add: (h: { key: string; value: string }) => void headers.push([h.key, h.value]),
    upsert: (h: { key: string; value: string }) => {
      const i = headers.findIndex(([k]) => k.toLowerCase() === h.key.toLowerCase());
      if (i === -1) headers.push([h.key, h.value]);
      else headers[i] = [h.key, h.value];
    },
    remove: (name: string) => {
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i]![0].toLowerCase() === name.toLowerCase()) headers.splice(i, 1);
      }
    },
  });

  const responseApi = (res: HttpResponse) => {
    const api = {
      code: res.status,
      status: res.statusText,
      responseTime: res.timeMs,
      responseSize: res.sizeBytes,
      headers: headerApi(res.headers),
      text: () => res.body,
      json: () => JSON.parse(res.body) as unknown,
      to: {
        have: {
          status: (code: number) => expect(res.status, `expected response status ${code}`).to.equal(code),
          header: (name: string, value?: string) => {
            const actual = api.headers.get(name);
            expect(actual, `expected response to have header "${name}"`).to.not.equal(undefined);
            if (value !== undefined) expect(actual).to.equal(value);
          },
          jsonBody: (path?: string) => {
            const body = api.json() as Record<string, unknown>;
            if (path) expect(body).to.have.nested.property(path);
          },
        },
        be: {
          get ok() {
            expect(res.status, "expected 2xx status").to.be.within(200, 299);
            return true;
          },
          get json() {
            expect(() => JSON.parse(res.body), "expected JSON body").to.not.throw();
            return true;
          },
        },
      },
    };
    return api;
  };

  const sendRequest = (
    input: string | { url: string; method?: string; header?: { key: string; value: string }[]; body?: { raw?: string } },
    callback?: (err: unknown, res?: ReturnType<typeof responseApi>) => void,
  ) => {
    if (!ctx.send) throw new Error("pm.sendRequest is not available in this context");
    const req: PreparedRequest =
      typeof input === "string"
        ? { method: "GET", url: input, headers: [] }
        : {
            method: input.method ?? "GET",
            url: input.url,
            headers: (input.header ?? []).map((h) => [h.key, h.value]),
            body: input.body?.raw !== undefined ? { kind: "text", text: input.body.raw } : undefined,
          };
    const promise = ctx.send(req).then(responseApi);
    if (callback) {
      pendingTests.push(promise.then((r) => callback(null, r), (e) => callback(e)));
    }
    return promise;
  };

  const legacyTests: Record<string, boolean> = {};

  const pm = {
    info: { eventName: ctx.event, requestName: ctx.requestName },
    environment: scopeApi("environment"),
    collectionVariables: scopeApi("collection"),
    globals: scopeApi("globals"),
    variables: {
      ...scopeApi("runtime"),
      /** Resolves through all scopes: runtime > environment > collection > globals. */
      get: (key: string) =>
        vars.runtime[key] ?? vars.environment[key] ?? vars.collection[key] ?? vars.globals[key],
      has: (key: string) => [vars.runtime, vars.environment, vars.collection, vars.globals].some((s) => key in s),
      replaceIn: (text: string) =>
        text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, k: string) => pm.variables.get(k.trim()) ?? m),
    },
    request: {
      get url() {
        return request.url;
      },
      set url(v: string) {
        request.url = v;
      },
      get method() {
        return request.method;
      },
      headers: mutableHeaderApi(request.headers),
      body: request.body,
    },
    response: ctx.response ? responseApi(ctx.response) : undefined,
    expect,
    test: (name: string, fn: () => unknown) => {
      try {
        const out = fn();
        if (out instanceof Promise) {
          pendingTests.push(
            out.then(
              () => void tests.push({ name, passed: true }),
              (e) => void tests.push({ name, passed: false, error: errorMessage(e) }),
            ),
          );
        } else {
          tests.push({ name, passed: true });
        }
      } catch (e) {
        tests.push({ name, passed: false, error: errorMessage(e) });
      }
    },
    sendRequest,
  };

  // Legacy Postman sandbox API (pre-2017 scripts still found in many collections).
  const postman = {
    setEnvironmentVariable: (k: string, v: unknown) => pm.environment.set(k, v),
    getEnvironmentVariable: (k: string) => pm.environment.get(k),
    clearEnvironmentVariable: (k: string) => pm.environment.unset(k),
    setGlobalVariable: (k: string, v: unknown) => pm.globals.set(k, v),
    getGlobalVariable: (k: string) => pm.globals.get(k),
    clearGlobalVariable: (k: string) => pm.globals.unset(k),
  };

  const log =
    (level: LogEntry["level"]) =>
    (...args: unknown[]) =>
      void logs.push({ level, message: args.map(stringify).join(" ") });
  const consoleApi = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("log") };

  let error: string | undefined;
  try {
    const fn = new AsyncFunction("pm", "postman", "console", "tests", "responseBody", "responseCode", code);
    await fn(
      pm,
      postman,
      consoleApi,
      legacyTests,
      ctx.response?.body,
      ctx.response ? { code: ctx.response.status, name: ctx.response.statusText } : undefined,
    );
    await Promise.all(pendingTests);
  } catch (e) {
    error = errorMessage(e);
  }

  for (const [name, passed] of Object.entries(legacyTests)) {
    tests.push({ name, passed: Boolean(passed) });
  }

  return { tests, logs, changes, request, error };
}
