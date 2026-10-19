---
title: Data model
summary: The TypeScript types every part of Getman shares - Workspace, Collection, Folder, RequestItem, Variable, Auth, Scripts.
status: implemented
tags: [data-model, types, schema, workspace, collection]
---

# Data model

Source of truth: `packages/core/src/model.ts`. Everything is plain JSON (no classes, no Dates) so it can be stored, synced and exported as-is.

```
Workspace
├── members: Member[]            { userId, email, role }
├── storage: StorageConfig       local | server{url} | git{remote, branch, path}
├── globals: Variable[]
├── environments: Environment[]  { id, name, variables }
├── activeEnvironmentId?
└── collections: Collection[]
    ├── variables, auth, scripts, description
    └── items: Item[]            Folder | RequestItem (recursive)
```

| Type | Key fields | Notes |
|---|---|---|
| `RequestItem` | `method`, `url`, `params`, `headers`, `body`, `auth`, `scripts` | `url` has **no** query string; `params` is the canonical query list (disabled params are kept). |
| `Folder` | `items`, `auth`, `scripts` | Auth `inherit` → parent. |
| `Collection` | `items`, `variables`, `auth`, `scripts` | Root of inheritance; its auth is never `inherit`. |
| `Variable` | `key`, `value`, `localValue?`, `secret`, `enabled` | See [variables](../features/variables.md). |
| `KeyValue` | `key`, `value`, `enabled`, `description?` | Params, headers, form fields. |
| `RequestBody` | `mode`: none, json, raw, form-urlencoded, form-data; `raw`; `form` | `raw` and `form` both kept so switching mode loses nothing. |
| `Auth` | `inherit` / `none` / `bearer` / `basic` / `apikey` | Discriminated union on `type`. |
| `Scripts` | `preRequest`, `test` | JavaScript source. |

IDs are UUID v4 (`crypto.randomUUID`). Importers always generate new IDs.

## Changing the model

1. Edit `model.ts` and the factories in `factory.ts`.
2. Update importers/exporters and their tests.
3. If the change affects stored data, bump the store `version` in `apps/desktop/src/lib/store.ts` and add a `migrate` step; if it affects files, bump `GETMAN_FORMAT_VERSION` in `packages/importers/src/getman.ts`.
4. Update this page.
