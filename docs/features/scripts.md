---
title: Scripts (pm API)
summary: Pre-request and test scripts, execution order, the complete supported pm.* API, legacy Postman API and sandbox rules.
status: implemented
tags: [scripts, tests, pm, postman, javascript, chaining]
---

# Scripts

JavaScript that runs **before** a request (*Pre-request*) or **after** the response (*Tests*). The API is compatible with Postman's `pm.*`, so imported collections keep working.

## Execution order

For a request inside folders:

```
collection pre-request → folder pre-request → … → request pre-request
→ send →
collection tests → folder tests → … → request tests
```

Variables changed by one script are visible to the next. After pre-request scripts run, variables are resolved again, so `pm.environment.set("token", …)` in a pre-request script affects the request being sent.

## Common recipes

```js
// Tests: save a value for the next request
pm.environment.set("userId", pm.response.json().id);

// Tests: assertions
pm.test("status is 201", () => pm.response.to.have.status(201));
pm.test("fast", () => pm.expect(pm.response.responseTime).to.be.below(500));

// Pre-request: get a token first (top-level await is allowed)
const res = await pm.sendRequest({
  url: pm.variables.replaceIn("{{baseUrl}}/oauth/token"),
  method: "POST",
  header: [{ key: "Content-Type", value: "application/json" }],
  body: { raw: JSON.stringify({ client_id: pm.environment.get("clientId") }) },
});
pm.environment.set("token", res.json().access_token);

// Pre-request: add a header
pm.request.headers.upsert({ key: "X-Signature", value: "..." });
```

## Supported API

### Variables
| API | Notes |
|---|---|
| `pm.environment.get/set/unset/has/clear/toObject` | Active environment. `set` writes the local value. Needs an active environment. |
| `pm.collectionVariables.*` | Same methods, collection scope. |
| `pm.globals.*` | Same methods, workspace globals. |
| `pm.variables.get(key)` | Resolves runtime → environment → collection → globals. |
| `pm.variables.set(key, value)` | Runtime scope (this session only). |
| `pm.variables.replaceIn(text)` | Resolves `{{vars}}` in a string. |

Non-string values passed to `set` are stored as JSON.

### Request (`pm.request`)
`url` (read/write in pre-request), `method`, `headers.get/has/add/upsert/remove/toObject/all`, `body`.

### Response (`pm.response`, tests only)
`code`, `status`, `responseTime` (ms), `responseSize` (bytes), `headers.get/has/toObject/all`, `text()`, `json()`,
`to.have.status(code)`, `to.have.header(name, value?)`, `to.have.jsonBody(path?)`, `to.be.ok`, `to.be.json`.

### Tests and assertions
- `pm.test(name, fn)`: `fn` may be async. A thrown error marks the test as failed.
- `pm.expect(value)`: [Chai](https://www.chaijs.com/api/bdd/) BDD assertions, same as Postman.

### Other
- `pm.sendRequest(urlOrRequest, callback?)`: returns a promise; callback `(err, res)` also supported. Request: `{ url, method, header: [{key, value}], body: { raw } }`.
- `pm.info.eventName` (`"prerequest"` | `"test"`), `pm.info.requestName`.
- `console.log/info/warn/error`: shown in the response **Console** tab.

### Legacy Postman API
`postman.setEnvironmentVariable/getEnvironmentVariable/clearEnvironmentVariable`, `postman.setGlobalVariable/getGlobalVariable/clearGlobalVariable`, `tests["name"] = boolean`, `responseBody`, `responseCode.code`.

### Not supported (yet)
See [limitations](../limitations.md#scripts).

## Sandbox and security

- Each script runs in a **fresh Web Worker** that is terminated afterwards: no state leaks between runs and an infinite loop cannot freeze the app.
- **10 second timeout.**
- `indexedDB`, `caches`, `localStorage` and `sessionStorage` are removed before the script runs, so scripts cannot read other workspaces.
- Scripts can make network calls (`fetch`, `pm.sendRequest`). Only run collections from sources you trust, same as Postman.
- Planned hardening: run scripts in a QuickJS (WASM) interpreter with no ambient network access.

## Implementation

- Engine: `packages/scripts/src/engine.ts` (`runScript`), tests in `packages/scripts/test/engine.test.ts`.
- Worker: `packages/scripts/src/worker.ts`; runner with timeout: `apps/desktop/src/lib/scriptRunner.ts`.
- Lifecycle: `apps/desktop/src/lib/runRequest.ts`.
