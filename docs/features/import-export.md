---
title: Import and export
summary: Supported formats, auto-detection, how fields are mapped, and what is lost in each direction.
status: implemented
tags: [import, export, postman, openapi, swagger, curl, yaml, migration]
---

# Import and export

## Import

**Import** accepts a file (drag and drop) or pasted text. The format is detected automatically.

| Format | Detected by | Result |
|---|---|---|
| Getman (`.yaml` / `.json`) | `getman: <version>` key | Collections + environments |
| Postman Collection v2.0 / v2.1 | `info.schema` contains `getpostman.com` | One collection |
| Postman Environment | `name` + `values[]` | One environment |
| OpenAPI 3.x / Swagger 2.0 (JSON or YAML) | `openapi` / `swagger` + `paths` | One collection |
| cURL | text starting with `curl ` | Collection with one request |

### Postman mapping
- Folders, requests, headers, query params (including disabled ones), descriptions: kept.
- Body: `raw` (JSON detected from `options.raw.language` or content), `urlencoded`, `formdata` (text fields).
- Auth: `noauth`, `bearer`, `basic`, `apikey`. A request/folder without `auth` → **Inherit**. Other types → Inherit (see limitations).
- Scripts: `prerequest` and `test` events on collection, folders and requests.
- Variables: collection `variable[]`; environment `values[]` with `type: "secret"` → secret variable.

### OpenAPI mapping
- `servers[0].url` (server variables replaced by defaults) or Swagger `schemes/host/basePath` → collection variable `baseUrl`.
- Each operation → request named `summary` → `operationId` → `METHOD /path`; grouped in folders by first tag.
- `/pets/{id}` → `{{baseUrl}}/pets/{{id}}`.
- Query parameters → params (enabled if required); header parameters → headers.
- `application/json` request body → JSON sample from `example`, or generated from the schema (`$ref`, `allOf`, `oneOf`, enums, formats).
- First security scheme → collection auth: bearer/oauth2 → `Bearer {{token}}`; basic → `{{username}}/{{password}}`; apiKey → `{{apiKey}}`. Secret variables are created for you to fill in.

### cURL mapping
`-X`, `-H`, `-d/--data/--data-raw/--data-binary/--data-urlencode`, `-F`, `-u`, `-G`, `-I`, `--url`, quoted args, `\` and `^` line continuations. JSON bodies become JSON mode; `a=1&b=2` bodies become form-urlencoded. Flags that don't change the request (`-k`, `-L`, `-s`, `--compressed`…) are ignored.

## Export

| Format | Use for |
|---|---|
| **Getman YAML** (default) | Committing to Git, backups, sharing with Getman users |
| Getman JSON | Tools that prefer JSON |
| Postman v2.1 | Opening in Postman or tools that read Postman collections. One file per collection/environment. |
| cURL | Request → **Code** tab. Variables resolved with the active environment. |

**Never exported:** local values and secret values (secret keys are exported with an empty value).

## Getman file format

```yaml
getman: 1
collections:
  - id: …
    name: My API
    items: [...]        # see architecture/data-model.md
    variables: [...]
    auth: { type: bearer, token: "{{token}}" }
    scripts: { preRequest: "", test: "" }
environments: [...]
```

`getman` is the format version. Newer files are rejected with a message asking to update Getman.

## Implementation

`packages/importers/src/*` (`importAny` is the entry point). Tests in `packages/importers/test/importers.test.ts`, including Postman and cURL round-trips.
