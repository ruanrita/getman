# Getman: instructions for AI agents

Open source API client. Read `docs/llms.txt` first; it indexes all documentation.

## Commands
- `pnpm install`, `pnpm dev` (UI in browser at :1420), `pnpm test`, `pnpm typecheck`
- Server: `docker compose -f apps/server/docker-compose.yml up -d db`, then `pnpm server` (:8787) and `pnpm test:server`
- Desktop: `pnpm tauri dev` (requires Rust + MSVC Build Tools on Windows)

## Layout
- `packages/core`: model, variables, permissions, request prep. Pure, no I/O.
- `packages/importers`: format converters. Pure.
- `packages/scripts`: pm.* engine + worker.
- `apps/server`: Fastify + Postgres. Routes in `src/routes`, migrations inline in `src/db.ts` (append only).
- `apps/desktop`: Tauri + React UI. State in `src/lib/store.ts`, request lifecycle in `src/lib/runRequest.ts`, server sync in `src/lib/sync.ts`.

## Rules
1. **Docs are mandatory.** Any change to behaviour updates, in the same change:
   - the feature page in `docs/` (and its frontmatter `status`: implemented | partial | planned),
   - `docs/limitations.md` (add new limits, delete fixed ones),
   - `docs/SPEC.md` feature table if status changed,
   - `docs/llms.txt` if a page is added/removed.
   The in-app AI assistant answers users from these files, so stale docs = wrong answers.
2. Pure packages stay pure: no DOM, storage or network imports in `core`, `importers`, `scripts/engine`.
3. Secrets: anything leaving the device (export, sync, backup, AI context) goes through `sanitizeVariables`; the server sanitizes again.
4. Server: every workspace route checks permissions through `access(req, id, action)`; never query workspace data without it.
5. New importer/exporter or pm API → add tests in the package's `test/` folder.
6. UI colours only via tokens in `apps/desktop/src/styles/tokens.css`.
7. Code, comments and docs in English.
