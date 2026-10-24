---
title: Known limitations
summary: What Getman cannot do yet and the workaround for each. The AI assistant checks this page first.
status: implemented
tags: [limitations, faq, support]
---

# Known limitations

Keep this page current: when a limitation is fixed, delete its entry in the same change.

## Collaboration and accounts
- **Git storage mode is not available yet.** Use the self-hosted server, or export as Getman YAML and commit it.
- **Adding members needs an existing account.** There are no email invitations yet; ask the person to create an account on the server first.
- **No password reset by email.** An admin with database access must reset it. No SSO/OIDC or passkeys yet.
- **Simultaneous edits to the same collection:** the version saved first wins. The other person's last edit to that collection (up to ~1 second of typing) is replaced and they see a notice. Edits to different collections never conflict.
- **Offline edits** to server workspaces are kept and pushed when the server is reachable again; if someone changed the same collection meanwhile, the rule above applies.
- **Session tokens and personal AI keys** are stored in the app's local storage, not yet in the OS keychain.
- **One server instance only.** Live updates are delivered in-process; running replicas behind a load balancer would miss events.
- **Signing out removes that server's workspaces from the device** (including local values typed for them).

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

## Backups
- Only server workspaces have built-in backups; local workspaces use **Export**.
- Restoring always creates a new workspace; there is no in-place restore.
- Backups run inside the single server instance; if the server is down when one is due, it runs at the next check after it starts.

## AI assistant
- Conversations are not saved between sessions.
- The assistant answers questions only; it cannot edit or send requests.
- Workspace AI answers arrive all at once (no streaming).
- In the browser dev build, non-Anthropic providers must allow CORS.

## Running from source
- `pnpm dev` runs the UI in a browser; requests go through a local dev proxy. The real desktop app needs Rust (see [getting started](guides/getting-started.md)).
