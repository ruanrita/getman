---
title: Automatic backups of local workspaces
summary: The desktop app copies every local workspace to a folder (default Documents/Getman/backups) every few minutes when it changed, keeps the last N copies, and restores any of them as a new workspace.
status: implemented
tags: [backup, local, restore, data-loss, safety, folder, desktop, onedrive]
---

# Automatic backups of local workspaces

A **local** workspace ("This device only") lives inside Getman's own storage. Reinstalling, clearing app data or a broken disk could lose it, so the desktop app keeps copies in a normal folder.

Server workspaces are protected by the server (history, trash, [backups](backup.md)); Git workspaces by your repository.

## How it works

- Every minute Getman checks each local workspace. If it **changed** since its last backup and the **interval** (default 10 minutes) has passed, it writes a copy.
- Files go to **`Documents/Getman/backups`** by default, named `getman-<workspace>-<id>-<date>-<time>.getman.yaml` (the Getman YAML format; it can also be opened with **Import**).
- The newest **30** copies of each workspace are kept; older ones are deleted.
- Copies include **unsaved changes** (drafts), so even work you have not saved yet is protected.
- **Never included:** secret values and device-local values. The folder may be synced by OneDrive, Google Drive or Dropbox, so secrets stay out of it. After restoring, fill secrets in again.

## Settings

⚙ workspace settings (of a local workspace) → **Automatic backups**:

- **on/off** (applies to all local workspaces);
- **Change folder…** / **Use default folder** / **Open folder**;
- interval (5, 10, 30 or 60 minutes) and how many copies to keep;
- **Back up now**;
- the most recent copies of this workspace, each with **Restore as copy**.

Tip: pointing the folder to a OneDrive / Google Drive / Dropbox folder gives you off-site copies for free.

## Restoring

- From the workspace's settings: **Restore as copy** next to a backup.
- If the workspace itself is gone: **+ New workspace → This device only → …or restore from an automatic backup** lists every backup in the folder.

Restoring always creates a **new** local workspace named "… (restored dd/mm hh:mm)"; nothing is overwritten.

Available in the desktop app only.
