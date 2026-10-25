---
title: Git workspaces
summary: Keep a workspace as YAML files in a Git repository (GitHub, GitLab, Bitbucket, any remote), commit and push from Getman, pull teammates' changes. File layout, what is never committed, conflicts.
status: implemented
tags: [git, github, gitlab, bitbucket, repository, version-control, yaml, collaboration, desktop]
---

# Git workspaces

Store a workspace **inside your code repository**, so API requests are versioned and reviewed together with the code. Available in the **desktop app**; it uses the `git` installed on your computer.

## Requirements

- Git installed and on `PATH` (https://git-scm.com).
- Access to the repository already working in your terminal (SSH key in the agent, or Git Credential Manager for HTTPS). Getman never asks for or stores Git credentials.

## Create or open

**+ New workspace → In a Git repository**, then:

- **Folder on this computer:** choose the repository folder (or any folder inside it). If it already has `.getman/`, that workspace opens; otherwise a new one is created with the name you typed.
- **Clone a repository:** paste the clone URL (`git@github.com:team/api.git`, `https://bitbucket.org/team/api.git`, …) and choose where to clone it.

An existing local workspace can be moved too: **⚙ → Save to a Git folder…** (the local copy is kept).

Teammates open the same repository folder in their Getman to get the same workspace.

## Files

```
your-repo/
└── .getman/
    ├── .gitattributes                 keeps LF line endings on every OS
    ├── workspace.yaml                 name, globals
    ├── environments/dev.yaml
    └── collections/payments/
        ├── collection.yaml            auth, variables, scripts, order of items
        ├── list-payments.yaml         one file per request
        └── auth/
            ├── folder.yaml
            └── login.yaml
```

- One file per request keeps diffs and merge conflicts small.
- File names come from item names (`List payments` → `list-payments.yaml`); renaming an item renames its file.
- Files are plain YAML: you can edit them in your editor, and files added by hand are picked up (appended after the saved order).
- Getman saves to the folder about half a second after each edit, so `git diff` always shows what you changed.
- **Never written:** secret values and device-local values. Secret variables are written with an empty value and `secret: true`, so teammates see they must fill them in locally.

## Commit, push, pull

Click the **⎇ branch** button in the top bar:

- shows the branch, its upstream, commits to push (↑) or pull (↓), and changed files in `.getman/`;
- **Commit & push** commits **only `.getman/`** (other work in your repository is left alone) and pushes; the first push sets the upstream;
- **Pull** fast-forwards only. If your branch and the remote diverged, merge or rebase in your terminal or Git tool, then click **Refresh**.

Getman also re-reads the folder when its window gets focus, so `git pull`, `git checkout` or edits made outside Getman show up automatically.

## Conflicts and broken files

If a file in `.getman/` has merge conflict markers or invalid YAML, Getman shows **▲ problem** in the top bar with the file name, keeps showing the last good version, and does not overwrite anything. Fix the file with your Git tool or editor, then click **Refresh** (or switch back to Getman).

## Permissions

Who can read, change or push is decided by your Git host (GitHub, GitLab, Bitbucket…). Getman roles, 2FA and audit log apply to [server workspaces](../guides/self-hosting.md) only.

## Implementation

- Format (pure, tested): `packages/importers/src/folder.ts`.
- Desktop: `apps/desktop/src/lib/gitSync.ts`, `src/components/GitModal.tsx`.
- Native commands: `apps/desktop/src-tauri/src/git.rs` (fixed git operations; writes confined to `.getman/`).
