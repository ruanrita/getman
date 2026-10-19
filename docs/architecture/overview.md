---
title: Architecture overview
summary: Monorepo layout, what each package does, how a request flows from click to response.
status: implemented
tags: [architecture, monorepo, packages, tauri, react]
---

# Architecture overview

```
getman/
├── apps/
│   ├── desktop/            Tauri 2 shell + React UI
│   │   ├── src/            UI (components/, lib/, styles/)
│   │   └── src-tauri/      Rust shell: window, native HTTP plugin
│   └── server/             (planned) Fastify + PostgreSQL, multi-user sync
├── packages/
│   ├── core/               Domain model, variables, permissions, request preparation. No I/O.
│   ├── importers/          Postman, OpenAPI, cURL, Getman format. Pure functions.
│   └── scripts/            pm.* engine (pure) + Web Worker entry (isolation)
└── docs/                   This documentation (also the AI assistant's knowledge base)
```

Packages export TypeScript source directly (`"main": "src/index.ts"`); Vite and Vitest compile them. No build step between packages.

**Rule:** `core`, `importers` and `scripts` have no UI, storage or network dependencies, so the server and the CLI can reuse them.

## Request lifecycle

`apps/desktop/src/lib/runRequest.ts`:

1. Find the request and its ancestors (`core/tree.findItemPath`).
2. For each pre-request script (collection → folders → request): run it in a Worker (`lib/scriptRunner.ts`), apply variable changes to the store.
3. Build the final request: `core/request.prepareRequest` resolves `{{vars}}` with the scope chain and applies auth (`core/tree.effectiveAuth` resolves *inherit*). Header/URL changes made by scripts are merged in.
4. Send (`lib/transport.ts`):
   - inside Tauri → `@tauri-apps/plugin-http` (native, no CORS);
   - in a browser (`pnpm dev`) → Vite dev proxy `/__getman/proxy`.
5. For each test script (same order): run it with the response, collect tests and logs, apply variable changes.
6. Store the `RunResult` (not persisted) for the response panel.

## State

`apps/desktop/src/lib/store.ts` is a single Zustand store persisted to IndexedDB (`idb-keyval`). Persisted: workspaces, active workspace, selection, theme. Not persisted: runtime variables, responses, running flags.

When storage modes arrive, the store will talk to a `StorageAdapter` (local / server / git) instead of persisting directly; see [storage](storage.md).

## Testing

`pnpm test` runs Vitest over `packages/*/test`. The UI has no automated tests yet.
