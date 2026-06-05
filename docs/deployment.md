# Nessie Production Deployment

Authoritative guide for the self-hosted production deployment. This supersedes
the historical GCP Cloud Run plan (`docs/done/phase2-gcp-deployment-spec.md`).

## Overview

Nessie production runs as Docker containers on a single Hetzner host, reusing the
shared edge proxy (Caddy) and joining the shared Docker networks that already
host other apps on that box. TLS is automatic via Caddy + Let's Encrypt. DNS is
Cloudflare (DNS-only / grey-cloud, matching the other apps on the host).

| Component | URL | Container | Network(s) |
|-----------|-----|-----------|------------|
| Admin SPA | `https://nessie.unlikeotherai.com` | `nessie-admin` (nginx) | `edge` |
| API (REST + WS) | `https://api.nessie.unlikeotherai.com` | `nessie-api` (Fastify, 5554) | `edge`, `db` |
| Worker | — (no ingress) | `nessie-worker` | `db` |
| Postgres + pgvector | — (internal) | `nessie-postgres` (pg17) | `db` |

- **Host:** `178.105.82.46` (Hetzner, Ubuntu 24.04), SSH as `root`.
- **Deploy root on host:** `/srv/nessie` (rsync'd working tree + build context).
- **Compose file:** `infrastructure/compose/docker-compose.prod.yml`.
- **Env file (host only, not committed):** `/srv/nessie/infrastructure/compose/.env`.

## Why these choices

- **Dedicated Postgres, not the shared one.** Nessie's migrations require the
  `vector` extension (`CREATE EXTENSION vector`, `vector(1536)` columns). The
  host's shared `postgres:17-alpine` lacks pgvector, so Nessie runs its own
  `pgvector/pgvector:pg17` container on the shared `db` network. Fully additive —
  it does not touch the shared Postgres or any other app's data.
- **No Redis.** The job queue and realtime transport are Postgres-backed
  (`PgQueueProvider` / `PgRealtimeTransport`), so no Redis is needed.
- **One backend image for API + worker.** The workspace is tightly interlinked
  (`@nessie/api` depends on `@nessie/worker`, both need the Prisma client). A
  single full-workspace image (`Dockerfile.app`) builds everything once; the
  worker container overrides the command to `node worker/dist/index.js`.
- **Admin is built static.** `Dockerfile.admin` bakes
  `VITE_API_BASE_URL=https://api.nessie.unlikeotherai.com` into the Vite bundle
  and serves it with nginx. The admin therefore calls the API cross-origin; the
  API's `NESSIE_CORS_ORIGINS` allowlists `https://nessie.unlikeotherai.com`.

## Shared infra (already on the host, do not disrupt)

`/srv/infra/docker-compose.yml` owns the `caddy` and shared `postgres`
containers and declares the external `edge` and `db` networks. Caddy mounts
`/srv/infra/caddy/Caddyfile`. Nessie only **appends** its two site blocks to
that Caddyfile (guarded by a `# === Nessie production ===` marker) and reloads
Caddy — it never rewrites the file. Other apps (voicepos, hugo) share the same
proxy and networks.

## First deploy (from a dev machine)

Requires SSH access to the host and the `CLOUDFLARE_API_TOKEN` env var.

1. **DNS** — create DNS-only A records → `178.105.82.46`:
   - `nessie.unlikeotherai.com`
   - `api.nessie.unlikeotherai.com`

2. **Sync source** to the host build root:
   ```sh
   rsync -az --exclude '.git' --exclude '**/node_modules' --exclude '**/dist' \
     --exclude '.worktrees' --exclude '*.png' \
     ./ root@178.105.82.46:/srv/nessie/
   ```

3. **Create `/srv/nessie/infrastructure/compose/.env`** from
   `.env.prod.example`. Set a strong `NESSIE_DB_PASSWORD` (bound to the Postgres
   volume on first boot — do not change it afterwards), a 32-byte
   `NESSIE_AUTH_SECRET` (`openssl rand -hex 32`), `NESSIE_MODEL_PROVIDER`, and
   the model/tool API keys.

4. **Build, migrate, start** (see `redeploy.sh` for the scripted version):
   ```sh
   cd /srv/nessie
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d postgres
   docker compose -f infrastructure/compose/docker-compose.prod.yml build api admin
   docker compose -f infrastructure/compose/docker-compose.prod.yml \
     run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:deploy
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d
   ```

5. **Caddy** — append the Nessie site blocks to `/srv/infra/caddy/Caddyfile`
   (admin → `nessie-admin:80`, API → `nessie-api:5554`), then:
   ```sh
   docker exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```

6. **First owner account** — Nessie runs in `selfHosted` mode with no users, so
   the API prints a one-time bootstrap URL on startup:
   ```sh
   docker logs nessie-api 2>&1 | grep bootstrap
   ```
   Open `https://nessie.unlikeotherai.com/bootstrap?token=<token>` and create the
   owner account. The token has a 15-minute TTL; restart `nessie-api` to mint a
   fresh one.

## Redeploying a new version

From the dev machine: `rsync` the updated tree to `/srv/nessie`, then on the host
run `infrastructure/compose/redeploy.sh` (rebuilds images, applies new
migrations, recreates the API/worker/admin containers). Postgres and its volume
are untouched.

## Verifying

```sh
curl https://api.nessie.unlikeotherai.com/api/health     # {"data":{"service":"api","status":"ok"}}
curl https://nessie.unlikeotherai.com/healthz            # ok
docker ps --filter name=nessie                           # all four healthy
docker logs nessie-worker 2>&1 | tail                    # "status":"ready"
```

## Configuration reference

Runtime config is layered: `nessie.config.json` (mounted read-only into the API
and worker) ← environment variables (`ConfigEnvMap` in `packages/config`). Key
production settings:

| Setting | Where | Value |
|---------|-------|-------|
| Mode | `NESSIE_MODE` | `selfHosted` (disables dev login, requires CORS allowlist) |
| DB URL | `DATABASE_URL` / `NESSIE_DB_URL` | `postgresql://nessie:***@nessie-postgres:5432/nessie` |
| CORS | `NESSIE_CORS_ORIGINS` | `https://nessie.unlikeotherai.com` |
| Auth secret | `NESSIE_AUTH_SECRET` | 32-byte hex; signs sessions, bootstrap tokens, and encrypts MCP OAuth secrets |
| Model | `NESSIE_MODEL_PROVIDER` + key | `openai` → `gpt-5-mini` chat, `text-embedding-3-small` (1536-dim) embeddings |
| Auth providers (SSO) | `nessie.config.json` `auth.providers` | see SSO below |

### MCP OAuth secret store

`api/src/services/mcp-oauth-secret-store.ts` provides a persistent,
AES-256-GCM-encrypted Postgres-backed `SecretStore` (table `mcp_oauth_secret`,
keyed off `NESSIE_AUTH_SECRET`). The API requires this in production — the MCP
route registrar refuses to boot with the in-memory stub under
`NODE_ENV=production`. **Known follow-up:** the read side
(`createPgSecretResolver`) is implemented but the worker/API tool dispatchers
still default to `NullSecretResolver` (a pre-existing phase-3 deferral), so
OAuth-authorized MCP connector tokens are stored securely but not yet consumed by
the agent loop.

## SSO (UnlikeOtherAuthenticator)

SSO targets **`https://authentication.unlikeotherai.com`** (UOA), the same
identity service the other apps on this host use. Integration notes live at
`https://authentication.unlikeotherai.com/llm` and `/api`.

**Current status:** SSO is **not yet wired**; first login is via the bootstrap
owner account + email/password. UOA is **not** standard OIDC — it does not serve
`/.well-known/openid-configuration`, and Nessie's current
`api/src/services/external-auth.ts` assumes standard OIDC discovery plus a
`userinfo_endpoint`. To enable UOA SSO, `external-auth.ts` needs a UOA-compatible
path:

- Use UOA's public OAuth surface: RFC 8414 metadata at
  `/.well-known/oauth-authorization-server`, `GET /oauth/authorize`,
  `POST /oauth/token` (PKCE, public client, no secret).
- Obtain a `client_id` via `POST /oauth/register` (RFC 7591 dynamic
  registration) with redirect URI **`https://nessie.unlikeotherai.com/login`**
  (the admin handles the `?code=` callback on `/login`; byte-exact allowlist).
- UOA returns an HS256 access token that RPs must not verify cryptographically
  (trust derives from the backend channel); extract `email`/`sub` from its
  claims instead of calling a `userinfo_endpoint`.
- Register the resulting provider in `nessie.config.json` `auth.providers`
  (`type: "uoa"`, `issuerUrl`, `clientId`).
