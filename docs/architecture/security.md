---
title: Security
summary: Secrets handling and script isolation (implemented); accounts, password hashing, 2FA, sessions and encryption at rest (planned).
status: partial
tags: [security, 2fa, totp, secrets, sandbox, authentication]
---

# Security

## Implemented

### Secrets
- Secret variables are masked in the UI and kept only in the device-local value.
- `sanitizeVariables` (core) strips local values and secret values; every exporter calls it, and every future sync/backup must call it too.
- Values set by scripts go to the local value, so runtime tokens are never shared.

### Script isolation
See [scripts → sandbox](../features/scripts.md#sandbox-and-security): fresh Worker per run, 10s timeout, storage APIs removed.

### Dev proxy
`pnpm dev` exposes `/__getman/proxy` on localhost only. It requires the `X-Getman-Proxy: 1` header (forces a CORS preflight) and rejects foreign `Origin`s, so other websites can't use it. It does not exist in the desktop build.

### Desktop
Tauri CSP limits the webview to its own origin; outgoing HTTP goes through the HTTP plugin (scoped to http/https in `src-tauri/capabilities/default.json`).

## Planned (phase 2: server)

### Accounts
- Email + password; password hashed with **argon2id**.
- Email verification and password reset via signed, single-use, 30-minute tokens.
- Optional OIDC/SSO login for companies (later).

### Two-factor authentication
- **TOTP** (RFC 6238, any authenticator app), enabled from account settings by scanning a QR code and confirming one code.
- 10 single-use **recovery codes**, shown once, stored hashed.
- Workspaces can **require 2FA** for all members (owner/admin setting).
- WebAuthn/passkeys as a second factor later.

### Sessions
- Desktop app gets a refresh token stored in the **OS keychain** and a short-lived access token.
- Users can list and revoke sessions; password change revokes all others.
- Rate limiting and lockout on login and 2FA attempts.

### Data at rest
- Workspace-level secrets (AI keys, backup credentials) are encrypted with AES-256-GCM using a key from the server environment (`GETMAN_ENCRYPTION_KEY`).
- Audit log for membership, role, backup and settings changes.
