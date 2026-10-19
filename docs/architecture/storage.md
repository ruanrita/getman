---
title: Storage modes
summary: Local (implemented), self-hosted server and Git (planned) - how each stores data, syncs, handles conflicts and permissions.
status: partial
tags: [storage, self-hosted, server, git, github, bitbucket, sync, postgres]
---

# Storage modes

Each workspace picks one mode. Only **Local** exists today.

| | Local ✅ | Server 📋 | Git 📋 |
|---|---|---|---|
| Where data lives | the app (IndexedDB) | PostgreSQL on your server | a Git repository |
| Multi-user | no | yes, real time | yes, via commits |
| Accounts, 2FA, roles | n/a | **Getman** | the **Git host** (GitHub/GitLab/Bitbucket) |
| Offline | yes | read cache + queued edits | yes (commit later) |
| History | no | audit log | `git log` |

## Storage adapter (planned interface)

```ts
interface StorageAdapter {
  load(workspaceId: string): Promise<Workspace>;
  apply(workspaceId: string, ops: Operation[]): Promise<void>; // fine-grained edits
  subscribe(workspaceId: string, onRemote: (ops: Operation[]) => void): () => void;
}
```

The UI works with operations (`updateItem`, `addItem`, …) that the store already exposes, so moving from "persist whole state" to adapters does not change components.

## Server mode (phase 2)

- `apps/server`: Fastify + PostgreSQL, one Docker image + `docker-compose.yml` with Postgres.
- Tables: `users`, `sessions`, `totp`, `workspaces`, `members`, `collections` (JSONB tree), `environments`, `audit_log`, `backups`.
- Sync: REST for load/save, WebSocket for live updates. Conflict rule: last write wins **per item** (not per collection), with the item's `updatedAt` compared server-side; the losing client gets a notice.
- Local values and secrets never leave the device (`sanitizeVariables` runs before every upload).

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
