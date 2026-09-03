# Redeploying, and why it no longer takes the site down

Chapter of [deployment.md](../deployment.md). Images build on GitHub and the host only pulls; the swap is a health-gated blue-green rollout, gated again on the public endpoints.

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
migrations, rolls the containers). Postgres and its volume are untouched.

### Images are built on GitHub, never on the production host

The Deploy workflow's `build` job builds `app`, `admin`, and `web` on GitHub
runners and pushes them to GHCR tagged with the commit SHA
(`ghcr.io/unlikeotherai/nessie-{app,admin,web}:<sha>`, cached per image with
`type=gha`). The `deploy` job then logs the host into GHCR with the run's own
short-lived `GITHUB_TOKEN`, and `redeploy.sh` **pulls** those images.

This exists because building on the box was an outage. Each deploy ran a full
monorepo install+compile for three images on a host shared with ~40 other apps:
measured at load average 340 on 8 cores with 0% idle, during which
`api.nessie.works` and `app.nessie.works` timed out through Caddy — the
containers were healthy, the host simply had nothing left to answer with, and
SSH hung too. Pulling a finished image costs a network transfer and nothing
else.

`redeploy.sh` decides by `NESSIE_IMAGE_TAG`: set (always, from the workflow) →
pull; unset → build locally, the manual/first-deploy fallback only. The compose
services keep their `build:` blocks for that path, with
`image: ${NESSIE_APP_IMAGE:-nessie-app:latest}` (and `_ADMIN_`/`_WEB_`) so one
file serves both. Because every deploy pulls a distinct SHA tag and tagged
images are never *dangling*, the post-deploy reclaim explicitly removes Nessie
release images other than the one just deployed — otherwise the shared disk
grows by a full image per deploy.

To deploy a specific build by hand:

```sh
cd /srv/nessie && NESSIE_IMAGE_TAG=<sha> bash infrastructure/compose/redeploy.sh
```

### Zero-downtime rollout (health-gated blue-green swap)

`redeploy.sh` does **not** stop-then-start the public-facing services. For
`api`, `admin`, and `web` it scales the Compose service to a second replica
built from the just-built image, polls the new container's Docker healthcheck
(`start_interval: 3s` during startup, so readiness is detected within seconds
of the API actually serving), and only after it reports **healthy** retires the
old replica — first disconnecting it from the `edge` network so its Docker DNS
record disappears and Caddy dials only the new one, then stopping and removing
it. Caddy targets the pinned network aliases `nessie-api` / `nessie-admin` /
`nessie-web` (declared in `docker-compose.prod.yml`), which every replica
carries, so the edge proxy config never changes across deploys.

Consequences worth knowing:

- **A broken image cannot take the site down.** If the new replica never goes
  healthy, `rollout()` removes it, the old container keeps serving, and the
  script (and the Deploy workflow) fails red with the new container's logs.
- The script ends with a **public-endpoint gate** — it curls
  `https://api.nessie.works/api/health`, `https://app.nessie.works/`, and
  `https://nessie.works/` through Caddy and exits non-zero on any failure, so a
  green deploy proves the site is actually up (previously a dead API could
  deploy "green" silently).
- These services have **no fixed `container_name`** (a pinned name cannot scale
  to two replicas); Compose names them `compose-api-1`-style, so read logs with
  `docker compose -f infrastructure/compose/docker-compose.prod.yml logs api`.
  `nessie-postgres`, `nessie-minio`, and `nessie-worker` keep their fixed names
  — they are never blue-greened (the worker is recreated in place; queued work
  waits out the gap).
- `redeploy.sh` takes a host-wide `flock` on `/var/lock/nessie-redeploy.lock`
  (30-min wait), so an out-of-band manual run cannot interleave with a Deploy
  workflow run. The workflow additionally serializes its own runs through the
  `deploy-production` GitHub concurrency group; queued runs it shows as
  "cancelled" were subsumed by a newer run that deploys their commits too.
- Migrations still run **before** the swap, while the old API is serving, so a
  schema change must remain compatible with the previous code for the length of
  the build+swap window (this was already true of the old recreate flow).
- In-flight SSE/WebSocket streams to the old API replica break at retirement;
  the admin's stream-retry/refetch paths reconnect to the new one.
- Optional hardening: the nessie site blocks in `/srv/infra/caddy/Caddyfile` can
  carry `lb_try_duration 10s` / `lb_try_interval 250ms` in their `reverse_proxy`
  blocks so Caddy re-dials across the swap instant rather than surfacing a rare
  502 to whoever hits it at exactly that moment.

The admin SPA also runs a production-only freshness check: browser, Tauri
desktop, and mobile WebView sessions fetch `/` with `cache: no-store` on
focus/visibility and every five minutes, and reload themselves when the served
`index.html` references different hashed assets than the loaded document. The
desktop shell and mobile WebView inject the same check as a second layer.
Already-open sessions need one reload to receive the mechanism.

To rotate the deploy key: generate a new keypair, append the public key to the
host's `~/.ssh/authorized_keys`, and `gh secret set DEPLOY_SSH_KEY` with the
private key.

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
- **Admin** (`infrastructure/docker/admin-nginx.conf`) — document responses add
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, HSTS, and a
  `Permissions-Policy` denying `camera`/`microphone`/`display-capture` (calls
  open in the selected provider, not inside the admin).
  `Content-Security-Policy-Report-Only` ships a baseline policy that reports
  without blocking; promote it to an enforcing `Content-Security-Policy` once
  the report stream is clean, and update its `connect-src` if the admin gains a
  new outbound origin.
- **Public web** (`infrastructure/docker/web-nginx.conf`) — the holding page
  uses the same baseline document headers and an enforcing CSP because it only
  serves static local assets.

Verify after deploy: `curl -sI https://api.nessie.works/api/health`,
`curl -sI https://app.nessie.works/`, and `curl -sI https://nessie.works/`
should show the expected headers.
