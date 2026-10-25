---
title: Product spec and roadmap
summary: What Getman is, every planned feature, delivery phases and scope decisions.
status: partial
tags: [product, roadmap, scope]
---

# Getman: product spec

## Vision

An open source API client that teams can **own**: run it locally, on their own server, or straight from a Git repository. It is compatible with Postman collections and scripts so migrating is cheap, and it is documented well enough that an AI assistant can answer user questions from the docs alone.

## Principles

1. **Your data, your infra.** No Getman cloud. Local, self-hosted, or Git.
2. **Postman-compatible.** Import/export Postman v2.1 and run `pm.*` scripts unchanged.
3. **Secrets never leave the device by accident.** Secret and local values are never synced or exported.
4. **Docs are part of the product.** Every feature ships with a doc page. The AI assistant answers from them.
5. **Bring your own AI.** Getman never provides or pays for an LLM.

## Decisions taken

| Topic | Decision | Why |
|---|---|---|
| App type | Desktop (Tauri 2 + React + TypeScript). Web app later, out of scope now. | Small binary, native HTTP without CORS. |
| Server | Node.js + Fastify + PostgreSQL (`apps/server`, planned) | Shares `packages/core` and importers with the app. |
| Base colour | Light blue `#5AB4F0` | See [design system](architecture/design-system.md). |
| Native file format | YAML, versioned envelope | Diffs well in Git. |
| Docs language | English | Open source audience; the AI assistant answers in the user's language. |

## Features and status

| # | Feature | Status | Doc |
|---|---|---|---|
| 1 | Requests: methods, params, headers, body (JSON, raw, urlencoded, form-data), auth (bearer, basic, API key) | ✅ implemented | [getting started](guides/getting-started.md) |
| 2 | Collections, folders, auth and script inheritance | ✅ implemented | [data model](architecture/data-model.md) |
| 2b | Explicit save: edits are local drafts until Ctrl+S / Save all; drafts survive restarts | ✅ implemented | [saving](features/saving.md) |
| 2c | Merge per request on save; compare-and-choose on conflicts | ✅ implemented (server) | [history](features/history.md) |
| 2d | Version history (requests, collections, environments) and 30-day trash | ✅ implemented (server) | [history](features/history.md) |
| 3 | Environments, globals, collection variables, shared vs local values | ✅ implemented | [variables](features/variables.md) |
| 4 | Secret variables (masked, never synced/exported) | ✅ implemented | [variables](features/variables.md) |
| 5 | Pre-request and test scripts, Postman `pm.*` compatible, isolated | ✅ implemented | [scripts](features/scripts.md) |
| 6 | Import: Postman collection v2.0/v2.1, Postman environment, OpenAPI 3, Swagger 2, cURL, Getman | ✅ implemented | [import/export](features/import-export.md) |
| 7 | Export: Postman v2.1, Getman YAML/JSON, cURL snippet | ✅ implemented | [import/export](features/import-export.md) |
| 8 | Roles (owner/admin/editor/viewer), ownership transfer, leave workspace | ✅ implemented (server workspaces) | [roles](features/roles.md) |
| 9 | Self-hosted server, multi-user workspaces, real-time sync, audit log | ✅ implemented | [self-hosting](guides/self-hosting.md), [storage](architecture/storage.md), [API](architecture/server-api.md) |
| 10 | Accounts, 2FA (TOTP + recovery codes), sessions, "require 2FA" per workspace | ✅ implemented | [security](architecture/security.md) |
| 10b | Email invitations, email verification, password reset by email | ✅ implemented | [accounts](features/accounts.md) |
| 10c | SSO/OIDC login, passkeys | 📋 planned | [security](architecture/security.md) |
| 11 | Git storage mode (GitHub, GitLab, Bitbucket, any remote) using the system git | ✅ implemented (desktop) | [Git workspaces](features/git.md) |
| 12 | Encrypted, scheduled backups to S3-compatible, server folder or another PostgreSQL; restore | ✅ implemented (server workspaces) | [backup](features/backup.md) |
| 13 | AI assistant (BYOK per user, or shared per workspace) answering from the docs | ✅ implemented | [AI assistant](features/ai-assistant.md) |
| 14 | More import formats: Insomnia, HAR, Bruno, Thunder Client | 📋 planned | [import/export](features/import-export.md) |
| 15 | Collection runner + `getman` CLI for CI | 📋 planned (phase 3) | - |
| 16 | Code generation beyond cURL (fetch, axios, Python, PHP, Go) | 📋 planned | - |

## Phases

**Phase 1: local app. ✅ Done.** Data lives in the app (IndexedDB inside the webview).

**Phase 2a/2b: team server. ✅ Done.**
- `apps/server`: Fastify + PostgreSQL, REST + WebSocket sync, Docker image.
- Accounts, email + password (argon2id), TOTP 2FA, recovery codes, session management.
- Role enforcement on every endpoint (rules from `packages/core/src/permissions.ts`), ownership transfer, audit log.
- Desktop: sign-in with 2FA, shared workspaces, members screen, publish a local workspace to a server.

**Phase 2c: backups and AI. ✅ Done.**
- Encrypted backups (S3-compatible, server folder, PostgreSQL), schedules, retention, restore into a new workspace.
- AI assistant: Anthropic via the official SDK, OpenAI-compatible providers (OpenAI, Gemini, OpenRouter, Ollama…), per-user keys or a workspace key proxied by the server.

**Next.**
- Session tokens and AI keys in the OS keychain.
- Collection runner and CLI (phase 3).

**Phase 3: Git and automation.**
- Git storage mode, one YAML file per request for clean diffs.
- Collection runner (data files, iterations) and `getman` CLI with JUnit/HTML reports.
- Mock server, GraphQL, WebSocket, SSE, gRPC.

## Out of scope (for now)

- Web version of the app.
- Getman-hosted cloud or any Getman-provided LLM.
- Mobile apps.
