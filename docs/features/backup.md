---
title: Backup
summary: Planned backup targets (S3-compatible, local folder, another database), schedule, encryption and restore.
status: planned
tags: [backup, restore, s3, minio, disaster-recovery]
---

# Backup

> **Status: planned (phase 2).** Not available yet. Today, use **Export → Getman YAML** to save a copy.

## Design

A backup is a **Getman YAML export** of a workspace plus metadata (members, roles, settings), compressed and **encrypted with AES-256-GCM** using a key the admin provides. Secrets and local values are never included, the same as exports.

### Targets (one or more per workspace)

| Target | Config |
|---|---|
| S3-compatible (AWS S3, MinIO, Cloudflare R2, Backblaze B2, Wasabi) | endpoint, bucket, prefix, region, access key (stored encrypted) |
| Local folder | path on the server (or on the device in local mode) |
| Another database | PostgreSQL connection string; writes to a `getman_backups` table |

### Schedule and retention
- Manual "Back up now" and cron-style schedule (default daily).
- Retention: keep last N or N days.
- Status and last error shown in workspace settings; failure notifies admins.

### Restore
- Restore into a **new** workspace (never overwrites silently), or replace the current one after typing its name to confirm.
- Requires the backup encryption key.

### Permissions
Only **admin** and **owner** can configure or restore backups (`backup.manage`).
