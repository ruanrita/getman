---
title: Getting started
summary: Install prerequisites, run Getman, send a first request and chain two requests with a script.
status: implemented
tags: [install, quickstart, tutorial]
---

# Getting started

## Run from source

Requirements: Node.js 22+, pnpm 10+.

```bash
pnpm install
pnpm dev          # UI at http://localhost:1420 (browser mode)
pnpm test         # unit tests for core, importers and scripts
```

In browser mode, requests go through a dev-only proxy in `apps/desktop/vite.config.ts` to avoid CORS.

### Desktop app (Tauri)

Extra requirements:
- Rust (https://rustup.rs)
- Windows: Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (already on Windows 11)
- macOS: Xcode command line tools. Linux: see https://tauri.app/start/prerequisites/

```bash
pnpm --filter @getman/desktop tauri icon public/getman.svg   # once, generates app icons
pnpm tauri dev      # desktop window with hot reload
pnpm tauri build    # installer in apps/desktop/src-tauri/target/release/bundle
```

## First request

1. Pick **Getman tour → Query params + headers** in the sidebar.
2. Press **Send** (or `Ctrl+Enter`).
3. The response appears below: **Body**, **Headers**, **Tests**, **Console**.

## Chain requests with a script

The tour collection shows the most common pattern: log in, store the token, use it.

1. Open **1. Auth flow → Login (stores token)** and send it. Its **Tests** script runs:
   ```js
   const token = pm.response.json().json.token;
   pm.environment.set("token", token);
   ```
2. Open **Who am I (uses token)**. Its auth is *Inherit*, and the collection auth is `Bearer {{token}}`. Send it: the stored token is used and both tests pass.
3. Open **Environments**: `token` now has a **Local value**. Values set by scripts stay on your machine.

## Import from Postman

**Import → drop your `.postman_collection.json`** (or environment file). Scripts, auth, folders and variables are kept. See [import/export](../features/import-export.md).

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/Cmd + Enter` | Send request |
| `Esc` | Close dialog |
| Double-click a name in the sidebar | Rename |
