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
| Public holding page | `https://nessie.works` | `nessie-web` (nginx) | `edge` |
| Admin SPA | `https://app.nessie.works` | `nessie-admin` (nginx) | `edge` |
| API (REST + WS) | `https://api.nessie.works` | `nessie-api` (Fastify, 5554) | `edge`, `db` |
| Push relay (optional) | `https://push.unlikeotherai.com` | `nessie-gateway` (Fastify, 5556) | `edge` |
| Worker | — (no ingress) | `nessie-worker` | `db` |
| Postgres + pgvector | — (internal) | `nessie-postgres` (pg17) | `db` |

- **Host:** `178.105.82.46` (Hetzner, Ubuntu 24.04), SSH as `root`.
- **DNS zone:** `nessie.works` in Cloudflare (`ffc45bc029478feb510f8e5791feaf20`),
  nameservers `magali.ns.cloudflare.com` and `woz.ns.cloudflare.com`. The domain
  is registered at 123-reg; the registrar nameservers must point to those two
  Cloudflare nameservers before DNS activates.
- **Deploy root on host:** `/srv/nessie` (rsync'd working tree + build context).
- **Compose file:** `infrastructure/compose/docker-compose.prod.yml`.
- **Env file (host only, not committed):** `/srv/nessie/infrastructure/compose/.env`.
- **Legacy aliases during migration:** `https://nessie.unlikeotherai.com` still
  serves the admin and `https://api.nessie.unlikeotherai.com` still serves the
  API while clients move to the new domains.

## Why these choices

- **Dedicated Postgres, not the shared one.** Nessie's migrations require the
  `vector` extension (`CREATE EXTENSION vector`, `vector(1536)` columns). The
  host's shared `postgres:17-alpine` lacks pgvector, so Nessie runs its own
  `pgvector/pgvector:pg17` container on the shared `db` network. Fully additive —
  it does not touch the shared Postgres or any other app's data. **The Compose
  service is named `nessie-postgres`, never `postgres`:** the service name becomes
  a DNS alias on the shared `db` network, so naming it `postgres` would collide
  with the shared Postgres container and make `postgres:5432` round-robin between
  two databases, breaking every other app on the host.
- **No Redis.** The job queue and realtime transport are Postgres-backed
  (`PgQueueProvider` / `PgRealtimeTransport`), so no Redis is needed.
- **One backend image for API + worker.** The workspace is tightly interlinked
  (`@nessie/api` depends on `@nessie/worker`, both need the Prisma client). A
  single full-workspace image (`Dockerfile.app`) builds everything once; the
  worker container overrides the command to `node worker/dist/index.js`.
- **Admin is built static.** `Dockerfile.admin` bakes
  `VITE_API_BASE_URL=https://api.nessie.works` into the Vite bundle and serves it
  with nginx. The admin therefore calls the API cross-origin; the API's
  `NESSIE_CORS_ORIGINS` allowlists `https://app.nessie.works` plus the legacy
  admin alias during migration.
- **Admin origin and API origin are not interchangeable.** The web app lives at
  `https://app.nessie.works`; the API lives at `https://api.nessie.works`. Any
  built admin artifact, including the Tauri desktop app when it embeds
  `admin/dist`, must use `VITE_API_BASE_URL=https://api.nessie.works`. Building
  with `https://app.nessie.works` makes `/api/auth/providers` resolve to the
  admin HTML shell, which leaves login stuck at "Loading providers...".
- **Desktop CORS is deliberate.** The Fastify CORS policy always allows the
  fixed Tauri app origins (`tauri://localhost` and `http://tauri.localhost`) in
  addition to the configured web admin origin, so embedded desktop builds can
  call `https://api.nessie.works` directly.
- **Proxy trust is explicit.** The API uses Fastify's configured proxy trust
  rather than parsing `X-Forwarded-For` itself. Production behind Caddy sets
  `NESSIE_API_TRUSTED_PROXY_HOPS=1`; local and unproxied deployments default to
  `0`, so forwarded client IP headers are ignored.

## Shared infra (already on the host, do not disrupt)

`/srv/infra/docker-compose.yml` owns the `caddy` and shared `postgres`
containers and declares the external `edge` and `db` networks. Caddy mounts
`/srv/infra/caddy/Caddyfile`. Nessie only edits the marked
`# === Nessie production ===` site block in that Caddyfile — it never rewrites
unrelated site blocks. Keep the Nessie block above the direct-IP `:80` catch-all
so Caddy's host-specific HTTP redirects and ACME challenge handling win for
`nessie.works`. Other apps (voicepos, hugo) share the same proxy and networks.

Caddy mounts the file read-only (`./caddy/Caddyfile:/etc/caddy/Caddyfile:ro`).
After editing the host file, validate it with the same Caddy data volume and
recreate only the Caddy service so Docker remounts the current file inode:

```sh
cd /srv/infra
docker run --rm \
  -v /srv/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v infra_caddy_data:/data \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d --force-recreate caddy
```

## First deploy (from a dev machine)

Requires SSH access to the host and the Cloudflare full-token env var.

1. **DNS** — in the `nessie.works` Cloudflare zone, create DNS-only records:
   - `A nessie.works` → `178.105.82.46`
   - `CNAME www.nessie.works` → `nessie.works`
   - `A app.nessie.works` → `178.105.82.46`
   - `A api.nessie.works` → `178.105.82.46`

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
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d nessie-postgres
   docker compose -f infrastructure/compose/docker-compose.prod.yml build api admin web
   docker compose -f infrastructure/compose/docker-compose.prod.yml \
     run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:deploy
   docker compose -f infrastructure/compose/docker-compose.prod.yml up -d
   ```
   The production Dockerfiles run package lint before building. A lint failure
   is a build failure.

5. **Caddy** — add or update the Nessie site blocks in `/srv/infra/caddy/Caddyfile`
   (holding page → `nessie-web:80`, admin → `nessie-admin:80`,
   API → `nessie-api:5554`). Place the block above the direct-IP `:80`
   catch-all, then validate and recreate only Caddy:
   ```sh
   cd /srv/infra
   docker run --rm \
     -v /srv/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
     -v infra_caddy_data:/data \
     caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker compose up -d --force-recreate caddy
   ```

6. **First owner account** — Nessie runs in `selfHosted` mode with no users, so
   the API prints a one-time bootstrap URL on startup:
   ```sh
   docker logs nessie-api 2>&1 | grep bootstrap
   ```
   Open `https://app.nessie.works/bootstrap?token=<token>` and create the
   owner account. The token has a 15-minute TTL; restart `nessie-api` to mint a
   fresh one.

### Granting the first super-admin

The `/api/platform/push/*` credential-management endpoints, and the
push-credentials admin page that uses them, are gated by the platform-level
`users.super_admin` flag. After the owner account exists, grant that tier from
the deployed tree:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts grant-super-admin owner@example.com
```

To audit or remove the tier later:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts list-super-admins
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm api \
  pnpm --filter @nessie/cli exec tsx src/index.ts revoke-super-admin owner@example.com
```

## Redeploying a new version

**Automatic (default):** every push to `main` triggers
`.github/workflows/deploy.yml`, which rsyncs the tree to `/srv/nessie` and runs
`infrastructure/compose/redeploy.sh` over SSH. The workflow authenticates with
the `DEPLOY_SSH_KEY` repo secret (a dedicated key in the host's
`~/.ssh/authorized_keys`); host/user come from the `DEPLOY_HOST` / `DEPLOY_USER`
secrets. The dedicated `LEDGER_PROXY_TOKEN` and `DEEPSIGNAL_MCP_APP_KEY`
Actions secrets are sent only over SSH standard input to the matching
`infrastructure/compose/set-*-app-key.sh` validator. Each validator atomically
updates the host-only Compose `.env`; neither secret enters the synced tree,
command arguments, or workflow output. `set-ledger-app-key.sh` writes the same
Nessie-specific caller credential to `LEDGER_PROXY_TOKEN` and
`NESSIE_MODEL_API_KEY`, rejects equality with every other configured
environment value, and never accepts a sibling app's key. The workflow fails
closed when any active dedicated key is missing or malformed. The retired
`LEDGER_BILLING_READ_APP_KEY_NESSIE` value is removed from the host `.env` by
the Ledger installer because raw reporting is now UOA-only. The Ledger caller,
DeepSignal caller, UOA, session, webhook, and sibling-product keys are separate
principals, not fallbacks.

The workflow rsyncs with `--delete` so files removed from the repo don't linger
on the host and get compiled into the image (a stale `api/src` copy left by the
mcp-manage extraction broke every build until this was added). rsync never
deletes excluded paths, so `infrastructure/compose/.env` (and any `.env`) is
preserved apart from that explicit single-key update, and the Postgres/MinIO
data live in named Docker volumes outside the synced tree.

**Manual:** from the dev machine `rsync` the tree to `/srv/nessie`, then on the
host run `infrastructure/compose/redeploy.sh` (rebuilds images, applies new
migrations, recreates the API/worker/admin containers). Postgres and its volume
are untouched.

`redeploy.sh` also checks for an interrupted
`20260613100000_channel_project_slugs` migration and marks that failed attempt as
rolled back before retrying it. The migration is idempotent and repairs existing
duplicate project-local channel slugs before adding the unique index.

The admin SPA also runs a production-only freshness check. Open browser, Tauri
desktop, and mobile WebView sessions fetch `/` with `cache: no-store` when the
app regains focus/visibility and every five minutes; if the freshly served
`index.html` references different hashed JS/CSS assets than the currently
loaded document, the session reloads itself. The desktop Tauri shell and mobile
WebView inject the same check as a second layer, so future native shells can
refresh stale hosted admin bundles even if the page bundle is wedged. Existing
already-open sessions still need one reload to receive this mechanism.

To rotate the deploy key: generate a new keypair, append the public key to the
host's `~/.ssh/authorized_keys`, and `gh secret set DEPLOY_SSH_KEY` with the
private key.

## Supported upgrade paths

Upgrades are applied by `prisma migrate deploy` against the existing database
(see `redeploy.sh`). CI proves this works for the path self-hosters actually
take — a database sitting on an older schema, not a fresh dev database:

- The `upgrade-path` job in `.github/workflows/ci.yml` restores
  `api/prisma/upgrade-fixtures/baseline.sql.gz` — a snapshot taken 20
  migrations behind the HEAD it was generated from (exact cut point in
  `baseline.json` next to it) — into a fresh Postgres, runs
  `prisma migrate deploy` from HEAD, validates the schema, and runs
  `api/scripts/upgrade-smoke.mjs` (all migrations recorded as applied, plus
  core queries over `users`, `organizations`, `messages`, `runs`,
  `task_events`, `audit_logs`). Any release within that trailing window is
  therefore a proven upgrade source.
- The fixture is reproducible: `node scripts/generate-upgrade-fixture.mjs`
  replays the migration history up to the cut point into a scratch database
  (never the real one) and re-dumps it. Regenerate it when the trailing
  window should move forward; use `--keep-last N` to widen or narrow it and
  `--docker <container>` on machines without local Postgres client binaries.
- Migration folders are immutable once committed. `pnpm lint:migrations`
  (part of the root `pnpm lint`) fails the build if a folder present at the
  merge-base is renamed, renumbered, deleted, or modified — all of which
  break `migrate deploy` for databases that already recorded the old row.
  It also prints a warning list (not a failure) when a new migration creates
  an index without `CONCURRENTLY` on the known-large tables `messages`,
  `task_events`, `runs`, `audit_logs`; on a large install those lock the
  table for the duration of the build, so review them before release.


### Host disk / Docker build cache (operational)

The host disk (`/`, ~300 GB) is **shared with other apps** on the box. Each
rebuild adds image layers and ~10 GB of Docker build cache; left unbounded this
filled the disk to 100% on 2026-06-10 and crashed `nessie-postgres`
(`PANIC: could not write … No space left on device`, stuck in WAL recovery and
rejecting connections — which also blocks `prisma migrate deploy`). Mitigations
now in place:

- `redeploy.sh` waits for Postgres to accept connections (`pg_isready`) before
  migrating, and after recreate prunes build cache older than 48h
  (`docker builder prune -f --filter until=48h`) plus dangling images.
- If the disk fills anyway, the safe manual reclaim (does **not** touch named
  volumes / running images): `docker builder prune -af` (build cache, 0 active)
  then `docker image prune -f` (dangling only). Avoid `image prune -a` and
  `--volumes` on this shared host. Check with `docker system df` / `df -h /`.
  Once space frees, Postgres finishes recovery on its own and goes healthy.

### Push relay (optional)

The standalone `@nessie/gateway` push relay is deployable but gated behind the
Compose `push` profile. The default `redeploy.sh` does not pass
`--profile push`, so it keeps building and starting only Postgres, API, worker,
and admin. The relay starts only when an operator deliberately enables that
profile.

Before enabling it, set the relay values in the host-only
`/srv/nessie/infrastructure/compose/.env` file. Do not commit real values.

- `GATEWAY_API_KEY` - bearer token accepted by `POST /v1/push`.
- `PUSH_APNS_P8`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID`,
  `PUSH_APNS_TOPIC`, `PUSH_APNS_ENV` - required together for APNs delivery.
- `PUSH_FCM_SERVICE_ACCOUNT` - Firebase service-account JSON string, required
  for FCM delivery.

Create a DNS-only A record for `push.unlikeotherai.com` pointing at
`178.105.82.46`, then append a third Nessie site block to
`/srv/infra/caddy/Caddyfile`:

```caddyfile
push.unlikeotherai.com {
  reverse_proxy nessie-gateway:5556
}
```

Validate and reload Caddy after the edit. To build and start only the relay:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml \
  --profile push build nessie-gateway
docker compose -f infrastructure/compose/docker-compose.prod.yml \
  --profile push up -d nessie-gateway
```

Self-hosted Nessie instances should point at
`https://push.unlikeotherai.com` for push delivery once their worker/API relay
client wiring is enabled. This deployment step only hosts the relay; it does not
make the Nessie API or worker call it yet.

## Verifying

```sh
curl https://api.nessie.works/api/health                 # {"data":{"service":"api","status":"ok"}}
curl https://api.nessie.works/api/auth/providers
curl https://app.nessie.works/healthz                    # ok
curl https://nessie.works/healthz                        # ok
docker ps --filter name=nessie                           # all five healthy
docker logs nessie-worker 2>&1 | tail                    # "status":"ready"
```

### Security response headers

Both edges set baseline security headers:

- **API** (`api/src/index.ts`, `onSend` hook) — every JSON response carries
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, and
  `Cross-Origin-Resource-Policy: cross-origin` (so the admin, on a different
  origin, can read responses). No CSP — the API serves no HTML. The hook does
  not run for hijacked SSE streams, so realtime is unaffected.
- **Admin** (`infrastructure/docker/admin-nginx.conf`) — the document responses
  add `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS, and a
  `Permissions-Policy` that **allows `camera`/`microphone`/`display-capture` for
  `self`** (required for in-browser video calls — do not tighten to `()`).
  `Content-Security-Policy-Report-Only` ships a baseline policy; it reports
  violations without blocking. Promote it to an enforcing
  `Content-Security-Policy` once the report stream is clean, and update its
  `connect-src` if the admin gains a new outbound origin.
- **Public web** (`infrastructure/docker/web-nginx.conf`) — the holding page
  uses the same baseline document headers and an enforcing CSP because it only
  serves static local assets.

Verify after deploy: `curl -sI https://api.nessie.works/api/health`,
`curl -sI https://app.nessie.works/`, and `curl -sI https://nessie.works/`
should show the expected headers.

## Configuration reference

Runtime config is layered: `nessie.config.json` (mounted read-only into the API
and worker) ← environment variables (`ConfigEnvMap` in `packages/config`). Key
production settings:

| Setting | Where | Value |
|---------|-------|-------|
| Mode | `NESSIE_MODE` | `selfHosted` (disables dev login, requires CORS allowlist) |
| DB URL | `DATABASE_URL` / `NESSIE_DB_URL` | `postgresql://nessie:***@nessie-postgres:5432/nessie` |
| CORS | `NESSIE_CORS_ORIGINS` | `https://app.nessie.works,https://nessie.unlikeotherai.com` (Tauri origins are allowed in code: `tauri://localhost`, `http://tauri.localhost`) |
| Trusted proxy hops | `NESSIE_API_TRUSTED_PROXY_HOPS` | `1` behind the production Caddy proxy; default `0` ignores `X-Forwarded-For`. Also the single trust decision for all auth rate-limit client IP keys — set it correctly or every proxied client shares the proxy's IP bucket. |
| Auth brute-force limits | `NESSIE_RATE_LIMIT_*` (`_MAX` / `_WINDOW_MS` per rule) | Postgres-backed fixed-window counters (`rate_limit_buckets`) on login (`LOGIN_IP` 10/10min, `LOGIN_ACCOUNT` 5/10min), refresh (`REFRESH_IP` 30, `REFRESH_ACCOUNT` 20), bootstrap (`BOOTSTRAP_IP` 10), MCP OAuth start/callback (`MCP_OAUTH_IP` 20), MCP secret writes (`MCP_SECRET_WRITE_IP` 20, `MCP_SECRET_WRITE_ACCOUNT` 10), and step-up password re-proof (`STEP_UP_IP` 10, `STEP_UP_ACCOUNT` 5). Trips return 429 + `Retry-After` and emit an `auth.rate_limit.lockout` audit event; the store fails open with a loud log on outage. Counters on `/api/ops/health`. Full table: [rate-limiting.md](rate-limiting.md) |
| Public API origin | `NESSIE_API_PUBLIC_URL` | `https://api.nessie.works` in production. Used to mint OAuth redirect URIs outside an HTTP request (personal-assistant `connector_authorize`); defaults to `http://localhost:<port>` |
| Public admin origin | `NESSIE_ADMIN_PUBLIC_URL` | `https://app.nessie.works` in production. UOA separately pins this origin on Nessie's billing lifecycle app key and authors Checkout/Portal return URLs; callers cannot supply or widen them through Nessie. |
| Ledger routing | `LEDGER_PUBLIC_URL`, `LEDGER_PROXY_TOKEN`, `LEDGER_DEEPWATER_MCP_URL`, `NESSIE_MODEL_BASE_URL`, `NESSIE_MODEL_API_KEY` | `LEDGER_PUBLIC_URL=https://ledger.unlikeotherai.com`; DeepWater uses `https://ledger.unlikeotherai.com/v1/mcp/deepwater`; builtin web search uses `/v1/serper/search`; configure inference with `https://ledger.unlikeotherai.com/v1/openai`, which Nessie rewrites per request to Ledger's `/v1/:serviceId/*` route for OpenAI, Kimi, MiniMax, or a custom adapter. `LEDGER_PROXY_TOKEN` is Nessie's dedicated, product-bound Ledger app API key used for DeepWater and Serper; `NESSIE_MODEL_API_KEY` is configured with that same Nessie key for the Ledger model transport. Never reuse another product's app key or a webhook signing secret. Every request carries signed non-null user/org/team/agent/run attribution; tool calls also carry their stable tool-call id, and linked SSO users carry UOA delegation when available. Direct provider keys, including `SERPER_API_KEY`, are not consumed. The deployment-wide model URL wins; when it is absent and an approved organization provider record resolves to Ledger, Nessie signs after route resolution and fails before fetch if signing identity is unavailable. User-triggered background jobs persist origin and fail before provider dispatch if it cannot be resolved. Workflow execution additionally checks queued actor/scope against its durable run and installation. DeepWater enablement fails closed when its adapter URL, Nessie app API key, UOA signing/client settings, or first-party catalog is absent. Integration-managed instances reject generic test, refresh, healthcheck, secret, and delete operations; the Integrations toggle is their sole lifecycle path. Personal DeepWater credentials are unsupported. |
| UOA commercial billing boundary | `UOA_BILLING_APP_KEY_NESSIE`, `UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE`, `UOA_BASE_URL` | Nessie's own `uoa_app_` customer-lifecycle key bound in UOA to the `nessie` service, exact actor issuer/audience/key, public half of the dedicated RS256 actor key, and `https://app.nessie.works` return origin. The app key and private JWK are separate GitHub Actions secrets. The deploy runner cryptographically validates both before its dependency-free host installer atomically updates the root-readable `.env`; neither may be reused by Ledger or another product. Every credits/add-on read, top-up/automatic-top-up/add-on action, customer-statement, Checkout, Portal, cancellation-preview, cancellation-confirm, and direct-session access-confirmation request carries a fresh 45-second actor JWT for the exact linked UOA user/org/team. Direct access is confirmed only after direct SSO exchange and before local session issuance; UOA failure blocks login and indirect product use never calls the seam. Nessie fixed-allowlists UOA's action id/path/body and renders UOA's display-ready remaining-credit model; browsers cannot provide upstream paths, action bodies, return URLs, app keys, actor assertions, balances, or commercial calculations. |
| DeepSignal MCP boundary | `DEEPSIGNAL_MCP_APP_KEY` | DeepSignal-issued, Nessie-only `dsk_` application key. Required at API and worker startup in hosted/self-hosted modes and installed into the production host `.env` from the same-named GitHub Actions secret. It must differ from every configured secret-bearing environment credential (Ledger/model/billing, UOA signing/client, auth/session, DB, storage, email/admin, provider, push, or webhook credentials) and every encrypted per-org DeepSignal webhook signing secret; API and worker startup validate both boundaries. The user-scoped managed instance stores only this env reference; each outbound chat/history/digest/action request adds exact `ai.invoke` UOA delegation and fresh signed Nessie provenance independently. There is no OAuth or personal-credential fallback. |
| Auth secret | `NESSIE_AUTH_SECRET` | 32-byte hex; signs sessions, bootstrap tokens, and encrypts MCP OAuth secrets |
| Session TTLs | `NESSIE_AUTH_TOKEN_TTL`, `NESSIE_AUTH_REFRESH_TOKEN_TTL` | optional, seconds; access JWT default 1800 (30 min), rotating refresh cookie default 2592000 (30 days). See [auth spec](deployment-modes-and-auth-spec.md) |
| Model | `NESSIE_MODEL_PROVIDER`, `NESSIE_MODEL_BASE_URL`, `NESSIE_MODEL_API_KEY` | Hosted production routes OpenAI-compatible chat and `text-embedding-3-small` embeddings through Ledger; direct provider keys are not used by Nessie. |
| Auth providers (SSO) | `nessie.config.json` `auth.providers` | see SSO below |
| Feedback → GitHub | `NESSIE_GITHUB_TOKEN`, `NESSIE_GITHUB_OWNER`, `NESSIE_GITHUB_REPO` | token (repo-scoped PAT) required to file issues from the Feedback section; owner/repo default to `UnlikeOtherAI`/`Nessie`. Without a token, feedback is stored but no issue is created (`status: saved`) |
| Storage backend | `NESSIE_STORAGE_PROVIDER` | `s3` in prod (MinIO); `filesystem` in local dev |
| Storage endpoint | `NESSIE_STORAGE_ENDPOINT`, `NESSIE_STORAGE_REGION`, `NESSIE_STORAGE_FORCE_PATH_STYLE` | `http://nessie-minio:9000`, `us-east-1`, `true` (path-style is required for MinIO) |
| Storage bucket/creds | `NESSIE_STORAGE_BUCKET`, `NESSIE_STORAGE_ACCESS_KEY_ID`, `NESSIE_STORAGE_SECRET_ACCESS_KEY` | bucket defaults to `nessie`; the key id/secret double as the MinIO root user/password (host `.env`) |
| Max upload size | `NESSIE_MAX_UPLOAD_BYTES` | default `5368709120` (5 GiB); also pins the API multipart limit |
| Web Push public key | `NESSIE_WEBPUSH_PUBLIC_KEY` | optional; VAPID public key served to browsers. Enables browser web push when set with the two below. See [web-push.md](web-push.md) |
| Web Push private key | `NESSIE_WEBPUSH_PRIVATE_KEY` | optional; VAPID private key that signs push JWTs (secret) |
| Web Push subject | `NESSIE_WEBPUSH_SUBJECT` | optional; VAPID subject, a `mailto:`/`https:` operator-contact URI. Generate the trio with `node scripts/generate-vapid-keys.mjs` |
| Comms Slack client id | `NESSIE_COMMS_SLACK_CLIENT_ID` | optional; Slack app OAuth client id for the Individual Communications Connector. Also read by the API OAuth-start (`oauth-config.ts`) to build the authorize URL |
| Comms Slack client secret | `NESSIE_COMMS_SLACK_CLIENT_SECRET` | optional (secret); Slack app OAuth client secret used for the code→token exchange |
| Comms Slack signing secret | `NESSIE_COMMS_SLACK_SIGNING_SECRET` | optional (secret); Slack Events API request-signing secret (`v0` HMAC). Slack registers only when all three of the above are set |
| Comms Google client id | `NESSIE_COMMS_GOOGLE_CLIENT_ID` | optional; Google OAuth client id for the Gmail connector. Also read by the API OAuth-start |
| Comms Google client secret | `NESSIE_COMMS_GOOGLE_CLIENT_SECRET` | optional (secret); Google OAuth client secret for the code→token exchange. Google registers when the id + secret are set |
| Comms Google Pub/Sub topic | `NESSIE_COMMS_GOOGLE_PUBSUB_TOPIC` | optional; fully-qualified `projects/<p>/topics/<t>` for Gmail `users.watch` push notifications. Sync still works without it (incremental polling); only real-time watch renewal needs it |

Communications connectors register from env at API and worker startup via
`@nessie/comms-providers`; a provider whose vars are unset simply does not
register, and its sync jobs park cleanly on `ConnectorNotRegisteredError`.
Startup logs one line listing the registered providers (no secrets).

### Object storage (MinIO)

File uploads — chat attachments, avatars/logos, and knowledge-base **file nodes**
+ **page attachments** — are stored in object storage through the single
`@nessie/runtime` `FileService`. Production runs a dedicated `nessie-minio`
container on the `db` network (the shared host has no S3); `nessie-minio-setup`
creates the bucket on each deploy. Set `NESSIE_STORAGE_ACCESS_KEY_ID` /
`NESSIE_STORAGE_SECRET_ACCESS_KEY` (and optionally `NESSIE_STORAGE_BUCKET`) in the
host `.env` — they are the MinIO root credentials and the app's S3 credentials.
Local dev keeps `filesystem` (zero setup); to exercise the S3 path locally, run a
MinIO container and set the `NESSIE_STORAGE_*` vars.

Every store/delete updates the `storage_usage_events` ledger, so per-org/team/
space/uploader usage is always known; a per-scope cap (`Budget.storageLimitBytes`)
blocks uploads (HTTP 507) when exceeded. The cap is set in the admin **Budgets**
screen ("Storage cap (GB)") alongside spend caps, and current usage shows in the
knowledge-base header. `MinIO` data lives in the `nessie_miniodata` volume — back
it up alongside `nessie_pgdata`.

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

User-authored MCP connectors are limited to HTTP/SSE remote endpoints. The API
and worker reject stdio process execution from catalog or instance data, and
MCP endpoint plus OAuth authorization/token URLs must pass the shared SSRF guard
before save or use. Private, local, link-local, and metadata-network targets
should be exposed through remote MCP runners instead of direct cloud callbacks.

## SSO (UnlikeOtherAuthenticator)

The admin login page shows a single **"Sign in with SSO"** button that takes the
user to **`https://authentication.unlikeotherai.com`** (UOA). UOA is **not**
standard OIDC — Nessie integrates via UOA's config-JWT flow
(`api/src/services/uoa-auth.ts`), implemented per the integration guide at
`https://authentication.unlikeotherai.com/llm` and `/api`.

**How it works**

- The API serves a signed RS256 **config JWT** at
  `GET /api/auth/sso/config` (the `config_url`) and the matching **JWKS** at
  `GET /.well-known/jwks.json`, both on `api.nessie.works`. The
  config allowlists both the hosted web callback and the native desktop
  callback: `nessie://auth/callback`. The config endpoint accepts
  `?theme=<theme-id>` so UOA can render with the user's selected Nessie palette.
- On the web, clicking the button sends the browser to
  `GET <uoa>/auth?config_url=…&redirect_url=https://app.nessie.works/login&code_challenge=…&code_challenge_method=S256`.
  The admin includes the resolved selected theme when it asks the API for this
  authorize URL; the API adds that theme to the UOA `config_url`.
- In the Tauri desktop app, clicking the button keeps the admin webview on the
  login page, opens the UOA authorize URL in the user's system browser, and uses
  `redirect_url=nessie://auth/callback`.
- UOA renders its login UI (email/password, Google, …). On web success it redirects
  to `https://app.nessie.works/login?code=…` (byte-exact allowlist; the
  admin handles the callback on `/login`). On desktop success macOS opens
  `nessie://auth/callback?code=…`; Tauri's deep-link plugin delivers that URL to
  the admin login page, which exchanges the code with the same redirect URL.
- The API exchanges the code server-to-server at `POST <uoa>/auth/token`
  authenticated with `Bearer <client_hash>` where
  `client_hash = SHA256(domain + client_secret)`. For themed login attempts,
  the callback exchange reuses the same themed `config_url` that was sent to
  UOA during authorize. The API then reads `email`/`sub` from the returned
  access-token claims. If UOA omits a usable `name` claim, or sends the email
  address as the name, Nessie stores a humanized email local part instead.
  Session hydration also repairs legacy email-shaped display names so chat
  messages do not render raw email addresses as sender names.
- The **first** SSO user on a fresh instance bootstraps the default
  workspace and becomes its owner — there is no separate owner-account step.
  Bootstrap mode is automatically suppressed whenever an SSO provider is
  configured.

**One-time onboarding (required before first login works)**

1. Generate an RSA-2048 keypair and set `UOA_CONFIG_JWT_PRIVATE_KEY_B64`
   (base64 of the PEM, single line) + `UOA_CONFIG_JWT_KID` in the host `.env`,
   plus `UOA_DOMAIN`, `UOA_CONFIG_URL`, `UOA_JWKS_URL`, `UOA_REDIRECT_URL`,
   `UOA_CONTACT_EMAIL` in `/srv/nessie/infrastructure/compose/.env`. The deploy
   already does this.
   `UOA_CONFIG_JWT_KID` must be unique per UOA domain. The `api.nessie.works`
   production integration uses `nessie-works-2026-06`; do not reuse the legacy
   `api.nessie.unlikeotherai.com` kid (`nessie-2026-06`) because UOA resolves
   `kid` globally, verifies the config with the old domain key, skips
   auto-onboarding, and then rejects `/auth/token` with 401 because no
   `api.nessie.works` client secret exists.
2. Validate the config JWT (optional sanity check):
   `curl -XPOST <uoa>/config/validate -d '{"config_url":"https://api.nessie.works/api/auth/sso/config"}'`
   — expect `schema_valid: true`, `domain_match: true`. The signature check
   stays `false` until UOA stores the JWKS at approval time.
3. Click **Sign in with SSO** once. UOA captures an integration request
   ("Integration pending review") for `api.nessie.works`.
4. A UOA **superuser approves** the integration; the contact email then receives
   a **one-time link to copy the `client_secret`**.
5. Set `UOA_CLIENT_SECRET` in the host `.env` and restart the API
   (`docker compose -f infrastructure/compose/docker-compose.prod.yml up -d --no-deps --force-recreate api`).
   SSO login is now live.

For the 2026-06-15 `nessie.works` migration, the live host env was updated to
`UOA_CONFIG_JWT_KID=nessie-works-2026-06`, UOA was prompted once via `/auth` so
it created a pending `api.nessie.works` request, a UOA superuser accepted that
request with one-time credential reveal, and the resulting `UOA_CLIENT_SECRET`
was written to `/srv/nessie/infrastructure/compose/.env` before recreating only
the `nessie-api` container.

`nessie.config.json` enables the provider (`type: "uoa"`, `enabled: true`); no
`clientId`/`issuerUrl` are needed (the config-JWT `config_url` identifies the
client, and the secret derives the bearer hash).
