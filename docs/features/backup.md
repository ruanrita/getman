---
title: Backup and restore
summary: Encrypted, scheduled backups of server workspaces to S3-compatible storage, a server folder or another PostgreSQL database; download, retention and restore.
status: implemented
tags: [backup, restore, s3, minio, r2, backblaze, postgres, disaster-recovery, encryption]
---

# Backup and restore

Available for workspaces on a [Getman server](../guides/self-hosting.md), to owners and admins: **⚙ workspace settings → Backups**. Local workspaces are backed up automatically by the desktop app: see [local backups](local-backups.md).

## What a backup contains

Collections, environments, globals, the workspace name and settings, and the member list (emails and roles). **Never** secret values or local values (they are not on the server).

Each backup is one `.getman-backup` file, gzip-compressed and **encrypted with AES-256-GCM** using a key derived (scrypt) from a passphrase you choose. Without the passphrase the file cannot be read.

## Targets

| Target | You provide | Notes |
|---|---|---|
| **S3-compatible** (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, SeaweedFS…) | endpoint (empty for AWS), bucket, region, prefix, access key ID + secret | The bucket must exist. |
| **Server folder** | a sub-folder name | Only if the server operator set `GETMAN_BACKUP_DIR`; files are written inside it. |
| **PostgreSQL** | a connection string | Creates a `getman_backups` table (key, created_at, data). |

Credentials and the passphrase are stored on the server encrypted with `GETMAN_ENCRYPTION_KEY`, and never returned to the app.

**Test connection** writes, reads back and deletes a small file. Saving a target runs the same test.

Targets on private networks (LAN MinIO, an internal database) are blocked unless the server operator sets `GETMAN_ALLOW_PRIVATE_NETWORKS=true`; see [self-hosting](../guides/self-hosting.md).

## Schedule and retention

- Schedule: manual only, every hour, every day (default) or every week. The server checks every minute and runs what is due.
- **Back up now** runs immediately.
- Retention: keep the newest N successful backups (default 14); older files are deleted from the target.
- Each run shows time, result, size and whether it was manual or scheduled. A failed run shows the error on the target.
- Untick **enabled** to pause a target without deleting it. **Remove** deletes the target settings only; files already written stay.

## Restore

Restoring always creates a **new** workspace owned by you; it never overwrites the original.

- **From the list:** **Restore** next to a backup. Optionally re-adds the members (those with an account on this server; the original owner becomes admin).
- **From a file** (for example after the workspace was deleted): **+ New workspace → Shared on … → …or restore from a backup file**, choose the file and enter its passphrase. Any signed-in user can do this.
- **Download** saves the encrypted file, e.g. to keep a copy offline.

## Permissions

`backup.manage`: owner and admins. Creating, changing, removing targets and restores are written to the audit log.

## Implementation

`apps/server/src/backup/` (format, targets, service), `src/routes/backups.ts`; UI in `apps/desktop/src/components/BackupsTab.tsx`.
