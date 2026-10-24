---
title: Self-hosting the Getman server
summary: Run the team server with Docker, configure it, put it behind HTTPS, back up the database, and connect the desktop app.
status: implemented
tags: [self-hosted, server, docker, postgres, install, https, deploy]
---

# Self-hosting the Getman server

The server holds shared workspaces, accounts and 2FA. The desktop app works without it (local workspaces).

## Quick start (Docker)

```bash
cd apps/server
cp .env.example .env
# generate the encryption key and paste it into .env as GETMAN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
docker compose up -d
curl http://localhost:8787/health   # {"ok":true,"name":"getman-server","apiVersion":1}
```

This starts PostgreSQL 17 and the server on port **8787**. Database migrations run automatically at startup.

## Configuration (environment variables)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | | PostgreSQL connection string |
| `GETMAN_ENCRYPTION_KEY` | yes | | 32 random bytes, base64. Encrypts 2FA secrets. **Back it up**: losing it forces every user to set up 2FA again. |
| `PORT` | | `8787` | |
| `HOST` | | `0.0.0.0` | Use `127.0.0.1` when a reverse proxy runs on the same machine. |
| `CORS_ORIGINS` | | `http://localhost:1420,http://tauri.localhost,tauri://localhost` | Browser origins allowed to call the API. The desktop app does not need CORS. |
| `SESSION_TTL_DAYS` | | `30` | Sliding session lifetime. |
| `TRUST_PROXY` | | `false` | `true` behind nginx/Caddy/Traefik so client IPs and rate limits are correct. |
| `AUTH_RATE_LIMIT` | | `10` | Login/register/2FA attempts per minute per IP. |
| `GETMAN_BACKUP_DIR` | | (unset) | Enables "server folder" backup targets, written inside this directory. Mount a volume here in Docker. |
| `GETMAN_ALLOW_PRIVATE_NETWORKS` | | `false` | Lets backup targets and workspace AI base URLs use private/loopback addresses (LAN MinIO, internal Postgres, self-hosted LLM). Leave off on servers open to untrusted users. |

## HTTPS

Always put the server behind HTTPS in production. Example with Caddy:

```
getman.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

WebSockets (`/ws`) pass through Caddy automatically. With nginx, add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

## Connecting the desktop app

**Sign in → Server URL** (`https://getman.example.com`) → create an account or sign in. Then **+ New workspace → Shared on …**, or open a local workspace's ⚙ settings → **Publish to …**.

## Backups

Workspace admins configure their own encrypted backups in the app ([backup](../features/backup.md)). As the operator, also back up the whole database:

```bash
docker compose exec db pg_dump -U getman getman > getman-$(date +%F).sql
```

Keep `GETMAN_ENCRYPTION_KEY` safe and separate from database dumps: it decrypts 2FA secrets, backup credentials and workspace AI keys.

For local development and tests, an S3-compatible store (SeaweedFS) is available: `docker compose --profile s3 up -d s3` (port 58333).

## Running from source

```bash
docker compose -f apps/server/docker-compose.yml up -d db   # PostgreSQL on :55432
pnpm --filter @getman/server dev                           # reads apps/server/.env
pnpm --filter @getman/server test                          # needs the database above
```

Tests use the `getman_test` database (create it once: `docker compose exec db psql -U getman -c "create database getman_test"`) or `TEST_DATABASE_URL`.

## Scaling

One server instance only for now: live updates are delivered in-process. See [limitations](../limitations.md).
