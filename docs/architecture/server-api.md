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

### Email, password reset and invitations
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/password/forgot` | `{ email }` → always `{ ok, emailEnabled }`; emails an 8-digit code if the account exists |
| POST | `/auth/password/reset` | `{ email, code, newPassword }`; revokes all sessions, marks the email verified |
| POST | `/me/email/send-code` | 6-digit verification code; `cooldown` (429) within a minute |
| POST | `/me/email/verify` | `{ code }` → `{ joined: [{ id, name, role }] }` (pending invitations accepted) |
| POST | `/invites/accept` | `{ code }` → `{ joined }`; the invitation must be for the user's email |
| GET | `/workspaces/:id/invites` | `members.manage`: pending invitations |
| POST | `/workspaces/:id/invites/:iid/resend` | new code (+ email) → `{ invite, code, emailSent }` |
| DELETE | `/workspaces/:id/invites/:iid` | cancel |

`POST /workspaces/:id/members` with an email that has no account creates an invitation and returns `{ members, invite, code, emailSent }`. `/health` reports `features.email`. Register returns `verificationSent`.

Error codes: `invalid_code`, `cooldown`, `already_verified`, `email_disabled`, `email_failed`, `invite_email_mismatch`.

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

**Versions and merging.** Each collection, environment and the globals have a `version`. Writes send the version they were based on (`0` = create). Collection and environment saves return `{ version, merged?, conflicts }`: if others saved meanwhile, the server merges per request / folder / setting / variable and returns the stored copy in `merged`; items both sides changed keep the server copy and are listed in `conflicts` (`{ kind, id, name, reason }`). `409 version_conflict` remains for creating an id that exists, a base version no longer in the history, and globals.

### History and trash
| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:id/collections/:cid/versions` | newest first, with `savedBy`, `savedAt`, `changes` (added/changed/deleted requests) |
| GET | `/workspaces/:id/collections/:cid/versions/:v` | that version's collection |
| POST | `/workspaces/:id/collections/:cid/versions/:v/restore` | `collections.write`; saved as a new version |
| GET | `/workspaces/:id/collections/:cid/items/:itemId/history` | versions where that request/folder changed, with its content |
| GET | `/workspaces/:id/environments/:eid/versions` | environment versions |
| GET | `/workspaces/:id/trash` | deleted items (30 days) |
| POST | `/workspaces/:id/trash/:tid/restore` | editors |
| DELETE | `/workspaces/:id/trash/:tid` | admins: delete forever |

**Sanitizing.** The server strips `localValue` and blanks secret values (`sanitizeVariables`) before storing, even if a client sends them.

### Backups (`backup.manage`)
| Method | Path | Notes |
|---|---|---|
| GET | `/workspaces/:id/backup-targets` | `{ targets, runs (50 newest), localBackupsEnabled }`; never includes credentials |
| POST | `/workspaces/:id/backup-targets/test` | `{ kind, config, secrets }` → write/read/delete probe |
| POST | `/workspaces/:id/backup-targets` | `+ { name, schedule, retention, passphrase (≥12) }`; tested before saving |
| PATCH / DELETE | `/workspaces/:id/backup-targets/:tid` | PATCH `{ name?, schedule?, retention?, enabled? }` |
| POST | `/workspaces/:id/backup-targets/:tid/run` | runs now → `{ run }` |
| GET | `/workspaces/:id/backup-runs/:rid/download` | encrypted `.getman-backup` bytes |
| POST | `/workspaces/:id/backup-runs/:rid/restore` | `{ name?, restoreMembers }` → new workspace |
| POST | `/restore` | any user: `{ file (base64), passphrase, name?, restoreMembers }` → new workspace |

`kind`: `s3` (`config: { endpoint?, region, bucket, prefix, forcePathStyle }`, `secrets: { accessKeyId, secretAccessKey }`), `local` (`config: { folder }`), `postgres` (`config: { table? }`, `secrets: { connectionString }`). `schedule`: `manual | hourly | daily | weekly`.

Error codes: `target_unreachable`, `private_network`, `host_unresolvable`, `local_backups_disabled`, `backup_running`, `wrong_passphrase`, `invalid_backup`.

### Workspace AI
| Method | Path | Permission |
|---|---|---|
| GET | `/workspaces/:id/ai` | `workspace.read` → `{ enabled, provider, baseUrl, model, hasKey }` (never the key) |
| PUT | `/workspaces/:id/ai` | `ai.configure`: `{ provider: "anthropic" \| "openai-compatible" \| null, baseUrl?, model?, apiKey? }`; omit `apiKey` to keep it, `null` to delete |
| POST | `/workspaces/:id/ai/chat` | `workspace.read`: `{ system, messages: [{ role, content }] }` → `{ text, stopReason, model }`; 30/min |
| GET | `/workspaces/:id/ai/usage` | `ai.configure`: per-member requests and tokens, last 30 days |

Error codes: `ai_not_configured`, `ai_auth_failed`, `ai_rate_limited`, `ai_provider_error`.

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
