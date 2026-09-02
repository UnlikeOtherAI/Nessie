#!/usr/bin/env bash
# Rebuild + redeploy Nessie on the host after the source tree has been rsync'd
# to /srv/nessie. Run from /srv/nessie. Postgres and its volume are left intact.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f infrastructure/compose/docker-compose.prod.yml"

# One redeploy at a time on this host. The Deploy workflow already serializes
# its own runs via a GitHub concurrency group, but that cannot see an
# out-of-band manual run — and two redeploys interleaving (one rsyncing/
# building while the other rolls containers) corrupts the deploy. The lock
# lives OUTSIDE the synced tree: rsync --delete would replace the inode and
# split the lock. Waits up to 30 min for the other run, then gives up loudly.
exec 9>/var/lock/nessie-redeploy.lock
if ! flock -w 1800 9; then
  echo "Another redeploy holds /var/lock/nessie-redeploy.lock — aborting" >&2
  exit 1
fi

echo "==> Ensuring Postgres is up"
$COMPOSE up -d nessie-postgres

# Reclaim Docker build cache + dangling images BEFORE building. The shared host
# disk filled to 100% repeatedly (frequent deploys accumulate build cache faster
# than time-based eviction), crashing Postgres mid-deploy (PANIC: No space left
# on device). Pruning all build cache (0 active, safe) + dangling images up front
# guarantees the build has room. Image layer caching is separate and unaffected.
echo "==> Reclaiming Docker build cache + dangling images (pre-build)"
docker builder prune -af >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
df -h / | tail -1

echo "==> Building images (api + admin + web)"
$COMPOSE build api admin web

# The migrate step runs with --no-deps, which bypasses the nessie-postgres
# `depends_on: service_healthy` gate. A freshly (re)started Postgres can still be
# in WAL recovery ("the database system is not yet accepting connections") when
# the build finishes, so prisma migrate deploy would fail. Wait for Postgres to
# actually accept connections before migrating. pg_isready exits 0 only once the
# server is past recovery and accepting connections.
echo "==> Waiting for Postgres to accept connections"
for attempt in $(seq 1 30); do
  if $COMPOSE exec -T nessie-postgres pg_isready -U nessie -d nessie >/dev/null 2>&1; then
    echo "    Postgres ready (attempt $attempt)"
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "    Postgres still not accepting connections after 60s" >&2
    exit 1
  fi
  sleep 2
done

# Prisma stops at the first failed migration and refuses every later one
# (P3009), so a single migration that died mid-deploy parks the whole
# installation until somebody clears it by hand — production sat un-deployable
# for a day that way. Listed here are the migrations known to have failed
# *atomically*: each is wholly transactional, so Postgres rolled the entire file
# back and the database is exactly as it was before it ran. Marking one of those
# rolled-back is therefore safe, and lets `migrate deploy` replay it against a
# database that the repair migration ahead of it has since fixed.
#
# Only add a name here after confirming in the deploy log that it failed on a
# statement inside the transaction, and that something now makes the replay
# succeed. A migration that half-applied has to be resolved by hand.
RESOLVABLE_FAILED_MIGRATIONS=(
  # Interrupted mid-deploy; replays cleanly.
  20260613100000_channel_project_slugs
  # Failed 22P02 comparing against the enum value that
  # 20260901195000_tool_grant_source_snake_case renames into existence. That
  # repair migration now runs first, so the replay succeeds.
  20260901200000_tool_grant_principal_integrity
)

for migration in "${RESOLVABLE_FAILED_MIGRATIONS[@]}"; do
  failed="$(
    $COMPOSE exec -T nessie-postgres psql -U nessie -d nessie -tAc \
      "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$migration' AND finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1;" \
      2>/dev/null | tr -d '[:space:]' || true
  )"
  if [ "$failed" = "1" ]; then
    echo "==> Marking failed migration $migration for retry"
    $COMPOSE run --rm --no-deps api pnpm --filter @nessie/api run prisma:migrate:resolve-rolled-back "$migration"
  fi
done

echo "==> Applying database migrations"
$COMPOSE run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:deploy

# The App Store's first-party rows are seeded by migration, but their curated
# copy, categories, trust and Featured flags — and the two curated connectors
# (context7, deep-agent-crawl) — come from these seeds. Both are idempotent
# upserts keyed on stable ids, and both preserve any field a curator has since
# edited, so running them on every deploy converges the catalogue without
# clobbering hand curation. Without this the store shows the raw first-party
# rows as uncategorised "Other" cards. The ~5,500 registry apps are NOT seeded
# here — that is the worker's scheduled sync (heavy, external, 6-hourly).
echo "==> Seeding App Store catalogue (first-party + curated connectors)"
$COMPOSE run --rm --no-deps api pnpm --filter @nessie/api seed:connectors
$COMPOSE run --rm --no-deps api pnpm --filter @nessie/api seed:apps

# Zero-downtime rollout for the services Caddy fronts. Instead of the
# stop-then-start recreate (which took the site down for the whole API boot,
# and left it down when a broken image never came up), start a NEW replica of
# the service next to the old one, wait for its Docker healthcheck to pass,
# and only then retire the old replica. Caddy targets these services by the
# pinned network alias (nessie-api / nessie-admin / nessie-web) which both
# replicas carry, so Docker DNS moves traffic to the survivor by itself; the
# Caddyfile's lb_try_duration on the nessie blocks re-dials across the brief
# swap instant. If the new replica never becomes healthy it is removed and the
# OLD one keeps serving — the deploy fails loudly instead of taking the site
# down with it.
rollout() {
  local service="$1"
  local timeout="${2:-240}"

  # Clear out any non-running leftovers of this service first, so `--scale`
  # creates a genuinely new replica instead of restarting a stale container
  # built from an old image.
  local stale
  stale="$(comm -13 <($COMPOSE ps -q "$service" | sort) <($COMPOSE ps -aq "$service" | sort))"
  if [ -n "$stale" ]; then
    echo "$stale" | xargs docker rm -f >/dev/null 2>&1 || true
  fi

  local old_ids
  old_ids="$($COMPOSE ps -q "$service" | sort)"

  if [ -z "$old_ids" ]; then
    # Nothing running (first deploy / previously failed): plain start.
    $COMPOSE up -d --no-deps "$service"
  else
    local old_count
    old_count="$(printf '%s\n' "$old_ids" | grep -c .)"
    $COMPOSE up -d --no-deps --no-recreate \
      --scale "$service=$((old_count + 1))" "$service"
  fi

  local new_id
  new_id="$(comm -13 <(printf '%s\n' "$old_ids") <($COMPOSE ps -q "$service" | sort) | head -1)"
  if [ -z "$new_id" ]; then
    echo "rollout($service): no new container was created" >&2
    return 1
  fi

  echo "    waiting for new $service replica ${new_id:0:12} to pass health checks"
  local waited=0
  while true; do
    local status
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$new_id" 2>/dev/null || echo missing)"
    case "$status" in
      healthy)
        break ;;
      starting|created|running)
        ;;
      *)
        echo "rollout($service): new replica is '$status' — removing it; the old replica keeps serving" >&2
        docker logs --tail 80 "$new_id" >&2 2>&1 || true
        docker rm -f "$new_id" >/dev/null 2>&1 || true
        return 1 ;;
    esac
    if [ "$waited" -ge "$timeout" ]; then
      echo "rollout($service): new replica not healthy after ${timeout}s — removing it; the old replica keeps serving" >&2
      docker logs --tail 80 "$new_id" >&2 2>&1 || true
      docker rm -f "$new_id" >/dev/null 2>&1 || true
      return 1
    fi
    sleep 3
    waited=$((waited + 3))
  done

  if [ -n "$old_ids" ]; then
    echo "    new $service replica healthy — retiring old replica(s)"
    local id
    for id in $old_ids; do
      # Drop the old replica out of edge DNS *before* stopping it, so Caddy
      # never dials a dying container: from this instant new requests resolve
      # only to the new replica. (Established streams to the old one break
      # here, exactly as they would at stop; the admin SPA reconnects.)
      docker network disconnect edge "$id" >/dev/null 2>&1 || true
      sleep 1
      docker stop "$id" >/dev/null
      docker rm "$id" >/dev/null
    done
  fi
}

echo "==> Rolling out api (health-gated blue-green swap)"
rollout api 240

echo "==> Rolling out admin + web"
rollout admin 90
rollout web 90

echo "==> Recreating worker + reconciling remaining services"
$COMPOSE up -d --no-deps worker
$COMPOSE up -d --no-recreate

# Final gate: prove the whole path (Caddy -> new containers) actually serves.
# Without this a deploy could go green while the site is down — the exact
# failure this script used to have.
echo "==> Verifying public endpoints through the edge proxy"
for url in \
  https://api.nessie.works/api/health \
  https://app.nessie.works/ \
  https://nessie.works/; do
  if curl -fsS --max-time 15 -o /dev/null "$url"; then
    echo "    OK $url"
  else
    echo "    FAILED $url" >&2
    exit 1
  fi
done

# Reclaim Docker build cache + dangling images. Each rebuild adds layers and
# ~10GB of build cache; left unbounded it filled the shared host disk to 100%,
# which crashed Postgres (PANIC: No space left on device, stuck in recovery).
# Keep only cache used in the last 48h so incremental rebuilds stay fast.
echo "==> Reclaiming Docker build cache + dangling images (post-deploy)"
docker builder prune -af >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

echo "==> Status"
docker ps --filter name=nessie --format 'table {{.Names}}\t{{.Status}}'
echo "==> Host disk"
df -h / | tail -1

cat <<'NOTE'

If this is the first deploy (no users yet), grab the one-time owner bootstrap URL:
  docker compose -f infrastructure/compose/docker-compose.prod.yml logs api 2>&1 | grep bootstrap
Then open https://app.nessie.works/bootstrap?token=<token>
NOTE
