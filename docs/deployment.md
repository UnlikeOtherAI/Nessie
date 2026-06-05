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

The admin login page shows a single **"Sign in with SSO"** button that takes the
user to **`https://authentication.unlikeotherai.com`** (UOA). UOA is **not**
standard OIDC — Nessie integrates via UOA's config-JWT flow
(`api/src/services/uoa-auth.ts`), implemented per the integration guide at
`https://authentication.unlikeotherai.com/llm` and `/api`.

**How it works**

- The API serves a signed RS256 **config JWT** at
  `GET /api/auth/sso/config` (the `config_url`) and the matching **JWKS** at
  `GET /.well-known/jwks.json`, both on `api.nessie.unlikeotherai.com`.
- Clicking the button sends the browser to
  `GET <uoa>/auth?config_url=…&redirect_url=https://nessie.unlikeotherai.com/login&code_challenge=…&code_challenge_method=S256`.
- UOA renders its login UI (email/password, Google, …). On success it redirects
  to `https://nessie.unlikeotherai.com/login?code=…` (byte-exact allowlist; the
  admin handles the callback on `/login`).
- The API exchanges the code server-to-server at `POST <uoa>/auth/token`
  authenticated with `Bearer <client_hash>` where
  `client_hash = SHA256(domain + client_secret)`, then reads `email`/`sub` from
  the returned access-token claims.
- The **first** SSO user on a fresh instance bootstraps the default
  workspace and becomes its owner — there is no separate owner-account step.
  Bootstrap mode is automatically suppressed whenever an SSO provider is
  configured.

**One-time onboarding (required before first login works)**

1. Generate an RSA-2048 keypair and set `UOA_CONFIG_JWT_PRIVATE_KEY_B64`
   (base64 of the PEM, single line) + `UOA_CONFIG_JWT_KID` in the host `.env`,
   plus `UOA_DOMAIN`, `UOA_CONFIG_URL`, `UOA_JWKS_URL`, `UOA_REDIRECT_URL`,
   `UOA_CONTACT_EMAIL` (see `.env.prod.example`). The deploy already does this.
2. Validate the config JWT (optional sanity check):
   `curl -XPOST <uoa>/config/validate -d '{"config_url":"https://api.nessie.unlikeotherai.com/api/auth/sso/config"}'`
   — expect `schema_valid: true`, `domain_match: true`. The signature check
   stays `false` until UOA stores the JWKS at approval time.
3. Click **Sign in with SSO** once. UOA captures an integration request
   ("Integration pending review") for `api.nessie.unlikeotherai.com`.
4. A UOA **superuser approves** the integration; the contact email then receives
   a **one-time link to copy the `client_secret`**.
5. Set `UOA_CLIENT_SECRET` in the host `.env` and restart the API
   (`docker compose -f infrastructure/compose/docker-compose.prod.yml up -d api`).
   SSO login is now live.

`nessie.config.json` enables the provider (`type: "uoa"`, `enabled: true`); no
`clientId`/`issuerUrl` are needed (the config-JWT `config_url` identifies the
client, and the secret derives the bearer hash).
