---
title: Server API
summary: REST and WebSocket API of the Getman server - endpoints, auth, error codes, sync protocol and realtime events.
status: implemented
tags: [api, rest, websocket, server, sync, errors, endpoints]
---

# Server API (v1)

Base URL: your server, e.g. `https://getman.example.com`. JSON in and out. Source: `apps/server/src`.

## Authentication

Send `Authorization: Bearer <token>`. Tokens are opaque random strings returned by sign-in; the server stores only their SHA-256. Sessions expire after `SESSION_TTL_DAYS` of inactivity.

## Errors

```json
{ "error": { "code": "version_conflict", "message": "Someone else changed this collection", "details": { … } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `validation` | 400 | Body failed validation; message names the field |
| `invalid_credentials` | 401 | Wrong email or password |
| `session_expired` / `unauthorized` | 401 | Missing, expired or revoked token |
| `mfa_expired` | 401 | 2FA challenge expired (5 min) or too many wrong codes (5) |
| `invalid_code` | 400/401 | Wrong TOTP or recovery code |
| `two_factor_required` | 403 | Workspace requires 2FA and the user has it off |
| `forbidden` | 403 | Role does not allow the action |
| `not_found` | 404 | Also returned for workspaces you are not a member of |
| `email_taken`, `already_member`, `2fa_already_enabled` | 409 | |
| `version_conflict` | 409 | `details` holds the current server copy and version |
| `rate_limited` | 429 | Too many auth attempts |

## Endpoints

### Auth and account
| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ ok, name: "getman-server", apiVersion }` |
| POST | `/auth/register` | `{ email, password (≥10), name }` → `{ token, user }` |
| POST | `/auth/login` | `{ email, password }` → `{ token, user }` or `{ mfaRequired: true, mfaToken }` |
| POST | `/auth/login/2fa` | `{ mfaToken, code }` (TOTP or recovery code) → `{ token, user }` |
| POST | `/auth/logout` | Revokes the current session |
| GET / PATCH | `/me` | Profile, `recoveryCodesRemaining`; PATCH `{ name }` |
| POST | `/me/password` | `{ currentPassword, newPassword }`; signs out other sessions |
| GET | `/me/sessions` | Devices; `DELETE /me/sessions/:id` revokes one |
| POST | `/me/2fa/setup` | → `{ secret, otpauthUrl }` (not active yet) |
| POST | `/me/2fa/enable` | `{ code }` → `{ recoveryCodes }` (10, shown once) |
| POST | `/me/2fa/disable` | `{ password, code }` |
| POST | `/me/2fa/recovery-codes` | `{ code }` → new set, old ones invalidated |

### Workspaces and members
| Method | Path | Permission |
|---|---|---|
| GET | `/workspaces` | own memberships |
| POST | `/workspaces` | anyone (becomes owner) |
| GET | `/workspaces/:id` | `workspace.read`; full snapshot with versions |
| PATCH | `/workspaces/:id` | `workspace.settings`; `{ name?, require2fa? }` |
| DELETE | `/workspaces/:id` | `workspace.delete` (owner) |
| GET | `/workspaces/:id/audit` | `members.manage`; 100 newest, `?before=<id>` to page |
| GET / POST | `/workspaces/:id/members` | POST `{ email, role }` adds an existing account (`members.manage`) |
| PATCH | `/workspaces/:id/members/:userId` | `{ role }`, rules in [roles](../features/roles.md) |
| DELETE | `/workspaces/:id/members/:userId` | remove, or leave when `:userId` is yourself |
| POST | `/workspaces/:id/transfer` | `{ userId }`, owner only |

### Content sync
| Method | Path | Body |
|---|---|---|
| PUT | `/workspaces/:id/collections/:cid` | `{ collection, baseVersion }` |
| DELETE | `/workspaces/:id/collections/:cid` | |
| PUT | `/workspaces/:id/environments/:eid` | `{ environment, baseVersion }` |
| DELETE | `/workspaces/:id/environments/:eid` | |
| PUT | `/workspaces/:id/globals` | `{ variables, baseVersion }` |

**Optimistic concurrency.** Each collection, environment and the globals have a `version`. Writes send the version they were based on (`0` = create). If it is not the current one the server answers `409 version_conflict` with the current copy in `details`; the client keeps the server copy and tells the user.

**Sanitizing.** The server strips `localValue` and blanks secret values (`sanitizeVariables`) before storing, even if a client sends them.

## Realtime (`GET /ws`, WebSocket)

```
→ { "type": "auth", "token": "…" }              ← { "type": "ready" }
→ { "type": "subscribe", "workspaceId": "…" }   ← { "type": "subscribed" } | { "type": "error", "code" }
→ { "type": "unsubscribe", "workspaceId": "…" }
```

The token is sent as the first message (not in the URL) so it never appears in proxy logs. Close codes: `4401` unauthorized / session revoked, `4400` bad message.

Events (only for subscribed workspaces, except `workspace.added`):

| Event | Payload |
|---|---|
| `collection.put` / `environment.put` | full object, `version`, `by` (user id) |
| `collection.deleted` / `environment.deleted` | `id`, `by` |
| `globals.put` | `globals`, `version`, `by` |
| `workspace.updated`, `members.updated` | re-read the snapshot |
| `workspace.removed` | `reason`: `deleted` or `access_revoked` |
| `workspace.added` | sent to a user when they are added to a workspace |
