---
title: Known limitations
summary: What Getman cannot do yet and the workaround for each. The AI assistant checks this page first.
status: implemented
tags: [limitations, faq, support]
---

# Known limitations

Keep this page current: when a limitation is fixed, delete its entry in the same change.

## Collaboration and accounts
- **No multi-user yet.** Workspaces are local to one machine. Self-hosted server and Git modes are planned (see [storage](architecture/storage.md)). Workaround: export as Getman YAML and commit it to a repository.
- **No accounts / 2FA yet.** They arrive with the self-hosted server.
- **Roles are not enforced yet.** The permission rules exist and are tested but only matter once workspaces are shared.

## Requests
- **No file uploads.** `form-data` fields are text only. Postman file fields are imported as text.
- **Binary responses** (images, PDFs, zip) are shown as text and may look garbled.
- **No path variables** (`:id` syntax). Use `{{id}}` instead. OpenAPI `{id}` paths are converted automatically.
- **Auth types:** only none, inherit, bearer, basic and API key. OAuth 2, Digest, AWS SigV4, NTLM, Hawk are not supported; requests using them fall back to "inherit". Workaround: obtain the token in a pre-request script with `pm.sendRequest` and set an `Authorization` header.
- **No proxy, client certificates (mTLS) or custom CA settings.**
- **Only HTTP.** GraphQL works as a JSON POST; WebSocket, SSE and gRPC are not supported.
- **Cookies** are not stored between requests (no cookie jar).

## Scripts
- `pm.sendRequest` body supports `raw` only (no urlencoded/formdata objects).
- Not available: `pm.cookies`, `pm.vault`, `pm.visualizer`, `pm.iterationData`, `pm.execution.setNextRequest`, `postman.setNextRequest`, `require()` of external modules (lodash, moment, etc.), `xml2Json`, `cheerio`.
- `pm.response.to` supports `have.status`, `have.header`, `have.jsonBody`, `be.ok`, `be.json`. Other Postman chai extensions are missing; use `pm.expect` instead.
- Scripts time out after 10 seconds.
- See [scripts](features/scripts.md) for the full supported API.

## Import / export
- Insomnia, HAR, Bruno and Thunder Client imports are not available yet.
- OpenAPI: external `$ref`s (other files/URLs) are not resolved; only the first server URL and the first security scheme are used.
- Postman: request examples (saved responses), collection-level `protocolProfileBehavior` and unsupported auth types are dropped on import.
- Exporting from the desktop app downloads through the webview; a native "Save as" dialog is planned.

## Running from source
- `pnpm dev` runs the UI in a browser; requests go through a local dev proxy. The real desktop app needs Rust (see [getting started](guides/getting-started.md)).
