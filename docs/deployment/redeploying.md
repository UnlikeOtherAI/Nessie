# Redeploying, and why it no longer takes the site down

Chapter of [deployment.md](../deployment.md). Images build on GitHub and the host only pulls; the swap is a health-gated blue-green rollout, gated again on the public endpoints.

## Redeploying a new version

**Automatic (default):** a completed `CI` run for `main` wakes
`.github/workflows/deploy.yml`. Before the build job receives package-write
permission or the deploy job receives SSH secrets, its read-only gate picks the
**newest commit on `main` that has a successful `push` CI run for that exact
SHA from this repository** — the tip when the tip's own CI is green, otherwise
the newest verified ancestor under it. It then checks out, builds, tags, syncs
and promotes only that SHA. A failed, cancelled, forked, wrong-branch or stale
CI event cannot promote an image, and a commit that is not on `main` is never a
candidate however green its CI.

The candidate list is one page of `main`'s history against one page of
completed CI runs (100 each), so a verified commit older than either page is
not reached back for; production waits for the next green CI instead.

The `deploy-production` lock stays serialized with `cancel-in-progress: false`.
GitHub retains the newest *event* while a run is pending, which may be a
delayed CI completion for an older commit. Failed, cancelled, untrusted and
non-`main` events use per-run ignored groups, so they cannot evict an eligible
pending deploy. Resolving eligibility after the shared lock is acquired prevents
the remaining queue inversion: an older successful event still promotes the
newest verified commit at the moment the lock is held, not the one its own
payload names.

**Why it walks back from the tip.** Requiring the tip *itself* to be verified
stalls production outright under merge traffic: the tip moves again before its
own CI finishes, so no deploy ever finds a green tip. On 2026-09-18 production
sat on `628068308` from 07:58 while six later Deploy runs reported success
having built and shipped nothing, and merged, CI-green commits waited hours.
Walking back keeps every safety property — the promoted SHA is on `main` and
has its own green trusted CI push run — and gives up only the pretence that
production always runs the very tip. A tip whose CI **failed** does not block
the last good commit from shipping.

**A run that promotes nothing is visible.** The run title says which case it is
before you open it (`Deploy — woken by green CI on <sha>`, `Deploy — manual
dispatch`, or `No deploy — CI failure on main`), the gate writes the decision
and the promoted SHA to the run summary, and the deploy job is named for the
SHA it ships. An ineligible wake-up — a failed CI, another branch, a foreign
repository — is ordinary and ends green. Getting past those checks and still
finding nothing verified anywhere on `main` is a **stall**, and the gate fails
the run on it: that state must never again be reported as a successful deploy.

**Manual:** use **Run workflow** for `Deploy` from `main`. It uses the same CI
gate and does not promote the UI-selected revision or bypass a
failed/cancelled CI run. Routine production promotion must not use direct host
commands.

After the gate, the workflow rsyncs the proven tree to `/srv/nessie` and runs
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

Before images, migrations, or a replacement container start, `redeploy.sh`
runs `ensure-encryption-key-ring.sh` against the host-only Compose `.env`.
For an older host it generates a distinct at-rest root, writes an active opaque
version and retains the old signing root only as `NESSIE_ENCRYPTION_LEGACY_KEY`;
it never prints either value. A partial ring fails the deploy before migrations.
After the new API and worker are serving, follow the operator-only rotation
procedure in [configuration.md](configuration.md#at-rest-encryption-rotation):
run the command, verify/retry to zero conflicts, then remove the legacy root.

The workflow rsyncs with `--delete` so files removed from the repo don't linger
on the host and get compiled into the image (a stale `api/src` copy left by the
mcp-manage extraction broke every build until this was added). rsync never
deletes excluded paths, so `infrastructure/compose/.env` (and any `.env`) is
preserved apart from that explicit single-key update, and the Postgres/MinIO
data live in named Docker volumes outside the synced tree.

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

### The deploy's SSH connections retry, its remote commands never do

Every `ssh` and the `rsync` in the Deploy job go through
`scripts/ssh-retry.sh`. It retries only exit 255 — ssh's own code for a
connection-level failure — with a growing pause, and returns any other code
at once, so a `redeploy.sh` that ran and failed is never run a second time.
A secret piped into a remote command is re-piped on every attempt
(`--stdin-var`), because a piped stdin is consumed by the first one.

The reason is the production host's sshd. On 2026-09-22 a brute-force wave
kept ten to fifteen unauthenticated connections pending against the default
`MaxStartups 10:30:100`, so sshd random-early-dropped new connections —
`kex_exchange_identification: read: Connection reset by peer` — and two
deploys in a row failed on their second connection with the images already
built. The host now runs `/etc/ssh/sshd_config.d/10-nessie-startups.conf`
(`MaxStartups 100:30:300`, `PerSourceMaxStartups 5`, `LoginGraceTime 30`);
the retry is what keeps a deploy alive when the wave outgrows that too. A
deploy that still fails this way is re-run with
`gh workflow run deploy.yml --ref main`, which uses the same exact-SHA gate.
Do not hold interactive SSH sessions to the host while a deploy is running:
they compete for the same startup slots.

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
  `https://nessie.works/` through Caddy. Each endpoint has up to five attempts
  (with a 15-second response timeout and three seconds between attempts) to
  allow Caddy's upstream discovery to converge after the swap; a persistent
  failure exits non-zero, so a green deploy proves the site is actually up
  (previously a dead API could deploy "green" silently).
- These services have **no fixed `container_name`** (a pinned name cannot scale
  to two replicas); Compose names them `compose-api-1`-style, so read logs with
  `docker compose -f infrastructure/compose/docker-compose.prod.yml logs nessie-api`.
  `nessie-postgres`, `nessie-minio`, and `nessie-worker` keep their fixed names
  — they are never blue-greened (the worker is recreated in place; queued work
  waits out the gap).
- `redeploy.sh` takes a host-wide `flock` on `/var/lock/nessie-redeploy.lock`
  (30-min wait), so an out-of-band manual run cannot interleave with a Deploy
  workflow run. The workflow additionally serializes its own runs through the
  `deploy-production` GitHub concurrency group; queued runs it shows as
  "cancelled" were subsumed by a newer run that deploys their commits too.
- Migrations normally run **before** the swap, while the old API is serving, so
  a schema change must remain compatible with the previous code for the length of
  the build+swap window. The generated Prisma client selects every scalar
  column, so a migration that drops a column or table, sets `NOT NULL`, or
  retypes a column breaks the previous release's replicas (P2022 on every query
  of the table; old worker jobs dead-letter with a deploy artifact as the
  recorded reason) from the moment it lands until the swap completes. The rule
  is enforced, not aspirational:
  - `scripts/lint-migrations.mjs` fails any migration in the tree containing
    `DROP COLUMN`, `DROP TABLE`, or `SET NOT NULL` that is not listed in
    `api/prisma/deploy-incompatible-migrations.json` (comments and string
    literals are parsed out, so prose never trips it).
  - `redeploy.sh` reads that same manifest and, while **any** listed migration
    is still pending in `_prisma_migrations`, drains every current and
    pre-rename API/worker container before Prisma runs, verifies none remain,
    and only then migrates and boots the compatible generation.

  When you genuinely need an incompatible migration, you have two options, and
  the lint failure message names both: split the change into
  **expand/backfill/contract across two releases** (see
  `20260911110000_project_team_inversion_expand`) so every intermediate schema
  serves both code generations — strongly preferred, because it keeps deploys
  zero-downtime — or add the migration to
  `api/prisma/deploy-incompatible-migrations.json` with the reason old clients
  break, accepting the deliberate maintenance gap while the deploy drains. If a
  drained deploy or the subsequent compatible boot fails, the script exits with
  the API and worker still stopped: do not roll an old image back onto the new
  schema. Fix and roll forward, or restore the database backup before starting
  the previous release.
- **The reconcile job runs between the migrations and the swap**, as a one-shot
  `$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api reconcile`.
  It seeds each organisation's default policy rules, backfills protected-MCP
  tool grants and Personal Assistant default grants, and sweeps expired refresh
  credentials — work every API replica used to do at boot, before it started
  serving. Boot now connects and listens
  ([standards/horizontal-scaling/overview.md](../standards/horizontal-scaling/overview.md) §5), so
  **skipping this step leaves a new organisation with no policy rules and
  deny-by-default answers.** Every step is idempotent and the job prints the
  rows it created; a redeploy that changes none of them reports zero. It exits
  non-zero on failure, which fails the deploy before the rollout starts.
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
  The `Content-Security-Policy` is **enforcing** (not report-only): this origin
  holds session tokens and renders attacker-supplied email HTML. Update its
  `connect-src` if the admin gains a new outbound origin. `script-src` is
  `'self' 'wasm-unsafe-eval'` — the narrow token is what lets the IronCalc
  spreadsheet grid compile its WebAssembly, and dropping it back to `'self'`
  alone breaks every workbook on web and in both desktop shells
  ([docs/standards/spreadsheets.md](../standards/spreadsheets.md)). It does not
  permit `eval()` on JavaScript, and `'unsafe-eval'` must never replace it.
- **Public web** (`infrastructure/docker/web-nginx.conf`) — the holding page
  uses the same baseline document headers and an enforcing CSP because it only
  serves static local assets.

Verify after deploy: `curl -sI https://api.nessie.works/api/health`,
`curl -sI https://app.nessie.works/`, and `curl -sI https://nessie.works/`
should show the expected headers.

## Service names are nessie-prefixed, the project name is not

Every service in `docker-compose.prod.yml` is `nessie-*`. That is not style:
**Compose always publishes the service name as a network alias and gives no way
to suppress it.** A service called `api` therefore made this project answer to
the bare name `api` on the *shared* `edge` network, alongside five other
products doing the same — and Docker round-robins a duplicated alias, so
anything resolving `api` reached a random product. `worker` had the same
collision with `deepcrm-worker` on the shared `db` network.

Public traffic was never affected, because every Caddy upstream names a
specific alias (`nessie-api:5554`, `nessie-admin:80`). The hazard was
container-to-container calls.

**Do not "finish the job" by setting a top-level `name:` in the compose file.**
Compose namespaces *volumes* by project name too. This project's name is the
directory name, `compose`, so the live database is the volume
`compose_nessie_pgdata`. Renaming the project makes Compose look for
`<newname>_nessie_pgdata`, fail to find it, silently create an empty one, and
bring production up with an empty database. The old volume survives; the site
does not. A project rename needs a deliberate volume migration, not a one-line
edit. Container names are already collision-proof without it, since the service
half is unique (`compose-nessie-api-1`).

### The one-time rename migration

Compose identifies a container by its project+service *label*, not its image or
name, so the first deploy after the rename does not recognise the running
generation. `redeploy.sh` handles both consequences and is idempotent:

- `nessie-worker` and `nessie-infisical` pin `container_name`, and those names
  were still held by the pre-rename containers — Compose would have failed with
  "container name already in use". They are removed *before* anything is
  created.
- `api`/`admin`/`web` pin no name, so Compose would simply start a second
  generation and never retire the first, leaving two generations sharing the
  `nessie-*` aliases indefinitely. They are retired *after* the new replicas
  pass their health checks, so the swap stays zero-downtime.

Both blocks are labelled in `redeploy.sh` and can be deleted once every
environment has deployed past the rename.
