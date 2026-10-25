---
title: Storage modes
summary: Local, self-hosted server and Git (all implemented) - how each stores data, syncs, handles conflicts and permissions.
status: implemented
tags: [storage, self-hosted, server, git, github, bitbucket, sync, postgres, offline, conflicts]
---

# Storage modes

Each workspace picks one mode: **Local**, **Server** or **Git**.

| | Local ✅ | Server ✅ | Git ✅ (desktop) |
|---|---|---|---|
| Where data lives | the app (IndexedDB) | PostgreSQL on your server | a Git repository |
| Multi-user | no | yes, real time | yes, via commits |
| Accounts, 2FA, roles | n/a | **Getman** | the **Git host** (GitHub/GitLab/Bitbucket) |
| Offline | yes | read cache + queued edits | yes (commit later) |
| History | no | audit log | `git log` |

## Server mode

Setup: [self-hosting](../guides/self-hosting.md). Protocol: [server API](server-api.md).

**Server side** (`apps/server`): PostgreSQL tables `users`, `sessions`, `mfa_challenges`, `recovery_codes`, `workspaces` (with globals), `members`, `collections` and `environments` (one JSONB document + `version` each), `audit_log`.

**Desktop side** (`apps/desktop/src/lib/sync.ts`):
- The workspace is cached in the app, so it opens instantly and works offline.
- Edits are drafts until the user saves ([saving](../features/saving.md)); only saved state is synced. A store subscription detects which collection / environment / globals changed (updates are immutable, so changed objects have new identities) and pushes them after a 600 ms debounce. Changes to local values only are not pushed.
- Every write carries the version it was based on. On `409 version_conflict` the server copy is applied and the user sees a notice. The unit of conflict is one collection or environment.
- One WebSocket per server receives teammates' changes; events that echo our own writes are recognised and ignored. On reconnect the app reloads the snapshot to catch up.
- When server data replaces local data, this device's local values are merged back in by variable key.
- If the server is unreachable, edits are queued and retried every 10 s.
- Signing out, removal from a workspace or its deletion removes the cached copy from the device.

**Publishing:** a local workspace can be copied to a server (⚙ → Publish); secrets and local values stay on the device, the local copy is kept.

**Scaling:** live events are delivered in-process, so run one instance. Multi-instance needs a shared bus (Postgres `LISTEN/NOTIFY` or Redis); planned.

## Git mode

User guide: [Git workspaces](../features/git.md).

- The `.getman/` folder of a working copy is the source of truth; the app keeps a cached copy only for device-local values (merged back by variable key).
- Writes: on save, a store subscription debounces (400 ms), serialises the workspace with `workspaceToFiles`, and writes only files whose content changed (`diffFiles`), deleting removed ones and empty folders.
- Reads: on start, on window focus, after Pull and on Refresh the folder is read and parsed with `filesToWorkspace`; if it differs from what Getman last wrote, the workspace is replaced. Parse errors (conflict markers, bad YAML) are shown and the last good copy is kept.
- Git operations run the system `git` through a fixed set of Tauri commands (`git.rs`): status of `.getman/`, `pull --ff-only`, add + commit limited to `.getman/` + push, clone. Terminal prompts are disabled so a missing credential fails instead of hanging.
- Files are written with LF; a `.getman/.gitattributes` (`* text eol=lf`) is created with the workspace.
