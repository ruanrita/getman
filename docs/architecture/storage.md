---
title: Storage modes
summary: Local and self-hosted server (implemented), Git (planned) - how each stores data, syncs, handles conflicts and permissions.
status: partial
tags: [storage, self-hosted, server, git, github, bitbucket, sync, postgres, offline, conflicts]
---

# Storage modes

Each workspace picks one mode: **Local** and **Server** exist; **Git** is planned.

| | Local ✅ | Server ✅ | Git 📋 |
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
- A store subscription detects which collection / environment / globals changed (updates are immutable, so changed objects have new identities) and pushes them after a 600 ms debounce. Changes to local values only are not pushed.
- Every write carries the version it was based on. On `409 version_conflict` the server copy is applied and the user sees a notice. The unit of conflict is one collection or environment.
- One WebSocket per server receives teammates' changes; events that echo our own writes are recognised and ignored. On reconnect the app reloads the snapshot to catch up.
- When server data replaces local data, this device's local values are merged back in by variable key.
- If the server is unreachable, edits are queued and retried every 10 s.
- Signing out, removal from a workspace or its deletion removes the cached copy from the device.

**Publishing:** a local workspace can be copied to a server (⚙ → Publish); secrets and local values stay on the device, the local copy is kept.

**Scaling:** live events are delivered in-process, so run one instance. Multi-instance needs a shared bus (Postgres `LISTEN/NOTIFY` or Redis); planned.

## Git mode (phase 3)

- Layout in the repo, one file per request so diffs and merge conflicts stay small:
  ```
  .getman/
    workspace.yaml
    environments/<name>.yaml
    collections/<collection>/collection.yaml
    collections/<collection>/<folder>/<request>.yaml
  ```
- The app clones/pulls, edits files, then commits and pushes on **Sync** (explicit, with a commit message).
- Works with any remote: GitHub, GitLab, Bitbucket, Gitea, Azure DevOps. Auth via HTTPS token or SSH key (stored in the OS keychain).
- Access control is whatever the Git host enforces; Getman roles don't apply.
- Merge conflicts in YAML are shown side by side; pick one or edit.
