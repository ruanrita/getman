---
title: Variables and environments
summary: Variable scopes, precedence, {{syntax}}, dynamic variables, shared vs local values and secret variables.
status: implemented
tags: [variables, environments, secrets, globals]
---

# Variables and environments

Use `{{name}}` anywhere: URL, params, headers, body, auth fields. Unknown variables are left as-is, so a request to `{{baseUrl}}/x` with no `baseUrl` fails with a clear "invalid URL" message.

## Scopes and precedence

Highest wins:

1. **Runtime**: set by scripts with `pm.variables.set()`. Lives until the app closes.
2. **Environment**: the one selected in the top bar. Manage in **Environments**.
3. **Collection**: collection → **Variables** tab.
4. **Globals**: **Environments → Globals**. Shared by all collections in the workspace.

Variables can reference other variables (`baseUrl = https://{{host}}/v1`), up to 5 levels deep.

## Shared value vs local value

Each variable has two values:

| | Shared value | Local value |
|---|---|---|
| Stored | in the workspace | only on this device |
| Synced to team / Git (when available) | yes | **never** |
| Exported | yes | **never** |
| Used when sending | when local value is empty | **always, if set** |

Scripts (`pm.environment.set`, `pm.collectionVariables.set`, `pm.globals.set`) write to the **local value**. Tokens you obtain at runtime therefore never end up in an export or a commit. This matches Postman's "current value".

## Secret variables

Tick 🔒 on a variable to make it secret:
- the value is masked (click 👁 to reveal);
- the shared value is cleared and disabled: the secret lives only in the local value;
- exports contain the key with an empty value, so teammates know they must fill it in.

Turning an existing variable secret moves its shared value into the local value.

## Dynamic variables

| Variable | Example |
|---|---|
| `{{$guid}}`, `{{$randomUUID}}` | `3f1c...` |
| `{{$timestamp}}` | `1792441918` (seconds) |
| `{{$isoTimestamp}}` | `2026-10-19T20:31:59.703Z` |
| `{{$randomInt}}` | `0`-`1000` |

## Implementation

`packages/core/src/variables.ts`: `resolve`, `scopeChain`, `effectiveValue`, `sanitizeVariables`. Tests in `packages/core/test/core.test.ts`.
