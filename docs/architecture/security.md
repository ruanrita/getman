---
title: Security
summary: Accounts, password hashing, 2FA (TOTP + recovery codes), sessions, secrets handling, encryption at rest, script isolation, and what is still planned.
status: implemented
tags: [security, 2fa, totp, secrets, sandbox, authentication, sessions, passwords]
---

# Security

## Accounts and passwords (server)
- Email + password, minimum 10 characters. Emails are case-insensitive.
- Passwords hashed with **argon2id** (`@node-rs/argon2`, OWASP baseline parameters).
- Login does the same hashing work whether or not the email exists, so response time does not reveal accounts.
- Login, register and 2FA endpoints are **rate limited** per IP (`AUTH_RATE_LIMIT`, default 10/min).
- Changing the password signs out every other session.

## Two-factor authentication
- **TOTP** (RFC 6238; SHA-1, 6 digits, 30 s; ±1 step tolerance). Works with any authenticator app.
- Setup is two steps: `/me/2fa/setup` returns the secret and QR URL; 2FA is only active after `/me/2fa/enable` confirms a code.
- **10 recovery codes** (`xxxx-xxxx-xxxx`, ~60 bits each), shown once, stored as SHA-256, each usable once.
- Sign-in with 2FA: password → short-lived challenge (5 min, max 5 wrong codes) → code → session.
- TOTP secrets are **encrypted at rest** with AES-256-GCM using `GETMAN_ENCRYPTION_KEY`.
- Turning 2FA off requires the password **and** a current code.
- Workspaces can **require 2FA** for all members.

## Sessions
- Opaque 256-bit random tokens; the database stores only their SHA-256.
- Sliding expiry (`SESSION_TTL_DAYS`, default 30).
- Users see their signed-in devices and can sign any of them out; revoking a session also closes its live connection.
- The WebSocket authenticates with its first message, never with a token in the URL.

## Secrets in workspaces
- Secret variables are masked in the UI and kept only in the device-local value.
- `sanitizeVariables` strips local values and secret values. Exporters call it, the desktop sync calls it before upload, **and the server calls it again** before storing, so even a buggy client cannot store secrets on the server.
- Values set by scripts go to the local value, so runtime tokens are never shared.

## Access control
- Non-members get **404** for a workspace (ids cannot be probed).
- Role checks on every endpoint; see [roles](../features/roles.md). Audit log of membership and settings changes.

## Desktop app
- Tauri CSP limits the webview to its own origin plus WebSocket connections; outgoing HTTP goes through the HTTP plugin.
- Scripts run in a fresh Web Worker with a 10 s timeout and no storage access ([scripts](../features/scripts.md#sandbox-and-security)).
- `pnpm dev` exposes a localhost-only dev proxy protected by a custom header and an Origin check; it does not exist in the desktop build.

## Backups
- Files are encrypted with AES-256-GCM using a key derived with scrypt (N=2^15) from a per-target passphrase; magic header `GMBK`, random salt and IV per file.
- Backup credentials (S3 keys, connection strings) and passphrases are stored encrypted with `GETMAN_ENCRYPTION_KEY` and never returned by the API.
- "Server folder" targets can only write inside `GETMAN_BACKUP_DIR` (relative names, no `.`/`..` segments, resolved path re-checked).

## Outbound connections (SSRF protection)
Any user can create a workspace and become its owner, so workspace settings must not let the server reach internal services. Backup endpoints, PostgreSQL targets and workspace AI base URLs are resolved and **rejected if they point at loopback, private, link-local, CGNAT or unique-local addresses**, unless the operator sets `GETMAN_ALLOW_PRIVATE_NETWORKS=true` (needed for LAN MinIO, an internal database or a self-hosted LLM). The check happens before each connection; DNS rebinding between check and connect is not prevented.

## AI keys
- **Personal keys** stay on the device and go only to the chosen provider.
- **Workspace keys** are stored encrypted on the server and never sent to clients; the server calls the provider and logs usage per member.
- Requests attached to a question have secrets, local values and credential headers masked before leaving the device.
- Replies are rendered as text (a minimal Markdown renderer that builds elements; no HTML from the model is executed).

## Planned
- Session tokens and personal AI keys in the **OS keychain** (today: app storage).
- Email verification, password reset and email invitations (needs SMTP).
- OIDC/SSO login, WebAuthn/passkeys as second factor.
