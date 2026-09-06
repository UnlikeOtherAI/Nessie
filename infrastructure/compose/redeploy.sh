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

# Image source. With NESSIE_IMAGE_TAG set (the Deploy workflow always sets it)
# the images were built on GitHub runners and are pulled here; the host
# compiles nothing. Unset, the script falls back to building locally, which is
# the manual/first-deploy path only — building on this shared box drove it to
# load ~340 with 0% idle and made the live site time out for the whole build.
NESSIE_IMAGE_TAG="${NESSIE_IMAGE_TAG:-}"
NESSIE_IMAGE_REPO="${NESSIE_IMAGE_REPO:-ghcr.io/unlikeotherai/nessie}"
if [ -n "$NESSIE_IMAGE_TAG" ]; then
  export NESSIE_APP_IMAGE="${NESSIE_IMAGE_REPO}-app:${NESSIE_IMAGE_TAG}"
  export NESSIE_ADMIN_IMAGE="${NESSIE_IMAGE_REPO}-admin:${NESSIE_IMAGE_TAG}"
  export NESSIE_WEB_IMAGE="${NESSIE_IMAGE_REPO}-web:${NESSIE_IMAGE_TAG}"
  echo "==> Using prebuilt images at tag ${NESSIE_IMAGE_TAG}"
fi

# --- One-time migration: services renamed api/admin/web/worker/infisical ->
# nessie-*. Compose tracks a container by its project+service LABEL, not by the
# image or the container name, so after the rename it no longer recognises the
# running generation as belonging to these services.
#
# Two distinct consequences, handled in two places:
#   * worker and infisical pin container_name, and those names are still held
#     by the pre-rename containers — Compose would fail outright with "container
#     name already in use". They are freed here, before anything is created.
#   * api/admin/web have no pinned name, so Compose simply starts a second
#     generation and never retires the first. Those are retired AFTER the new
#     replicas pass their health checks, further down, so the swap stays
#     zero-downtime.
#
# The project label is still "compose" (the directory name) and deliberately
# stays that way — see the note in docker-compose.prod.yml about volumes.
# Safe to delete this block, and its sibling below, once every environment has
# deployed past the rename.
legacy_service_containers() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=compose" \
    --filter "label=com.docker.compose.service=$1"
}

for legacy in worker infisical; do
  legacy_ids="$(legacy_service_containers "$legacy")"
  if [ -n "$legacy_ids" ]; then
    echo "==> Removing pre-rename '$legacy' container(s); it now runs as nessie-$legacy"
    echo "$legacy_ids" | xargs docker rm -f >/dev/null
  fi
done

echo "==> Ensuring Postgres is up"
$COMPOSE up -d nessie-postgres

# Reclaim disk. In the pull path this only drops images the swap orphaned; the
# build cache is bounded rather than wiped, because a full wipe (`prune -af`)
# forces the local-build fallback to rebuild from scratch every time.
echo "==> Reclaiming disk (bounded build cache + dangling images)"
docker builder prune -f --keep-storage 40GB >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true
df -h / | tail -1

if [ -n "$NESSIE_IMAGE_TAG" ]; then
  echo "==> Pulling prebuilt images"
  $COMPOSE pull nessie-api nessie-admin nessie-web
else
  # Local-build fallback (manual deploys / first deploy). ONE AT A TIME:
  # Compose builds in parallel by default and each image runs a full monorepo
  # install+compile — measured at load average 340 on this 8-core box with 0%
  # idle, which made the live site time out for everyone while it built.
  echo "==> No image tag supplied — building locally (api, then admin, then web)"
  $COMPOSE build nessie-api
  $COMPOSE build nessie-admin
  $COMPOSE build nessie-web
fi

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
    $COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api run prisma:migrate:resolve-rolled-back "$migration"
  fi
done

echo "==> Applying database migrations"
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api prisma:migrate:deploy

# The App Store's first-party rows are seeded by migration, but their curated
# copy, categories, trust and Featured flags — and the two curated connectors
# (context7, deep-agent-crawl) — come from these seeds. Both are idempotent
# upserts keyed on stable ids, and both preserve any field a curator has since
# edited, so running them on every deploy converges the catalogue without
# clobbering hand curation. Without this the store shows the raw first-party
# rows as uncategorised "Other" cards. The ~5,500 registry apps are NOT seeded
# here — that is the worker's scheduled sync (heavy, external, 6-hourly).
echo "==> Seeding App Store catalogue (first-party + curated connectors)"
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api seed:connectors
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api seed:apps

# Boot connects and listens — nothing else (docs/standards/horizontal-scaling.md
# §5). Default policy rules, the protected-MCP grant backfill, Personal
# Assistant default grants and the expired-credential sweep used to run on every
# API replica before it started serving; they run once here instead, after the
# migrations and before the rollout, so the new containers only connect and
# listen. Every step is idempotent, so a redeploy that changes none of them
# reports zero rows created.
echo "==> Reconciling policy defaults and tool grants"
$COMPOSE run --rm --no-deps nessie-api pnpm --filter @nessie/api reconcile

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
rollout nessie-api 240

echo "==> Rolling out admin + web"
rollout nessie-admin 90
rollout nessie-web 90

# Second half of the rename migration: the pre-rename api/admin/web generation
# is still running and still carries the nessie-api/-admin/-web aliases, so it
# would keep taking a share of live traffic forever. The new replicas are healthy
# by this point, so retiring the old ones now costs no downtime.
for legacy in api admin web; do
  legacy_ids="$(legacy_service_containers "$legacy")"
  if [ -n "$legacy_ids" ]; then
    echo "==> Retiring pre-rename '$legacy' replica(s) now that nessie-$legacy serves"
    for legacy_id in $legacy_ids; do
      docker network disconnect edge "$legacy_id" >/dev/null 2>&1 || true
      sleep 1
      docker rm -f "$legacy_id" >/dev/null
    done
  fi
done

echo "==> Recreating worker + reconciling remaining services"
$COMPOSE up -d --no-deps nessie-worker
$COMPOSE up -d --no-recreate

# Final gate: prove the whole path (Caddy -> new containers) actually serves.
# Without this a deploy could go green while the site is down — the exact
# failure this script used to have. Caddy's upstream discovery can briefly lag
# the completed blue-green swap, so let that convergence settle before calling
# a deploy failed. A persistent edge failure still fails the script loudly.
verify_public_endpoint() {
  local url="$1"
  local attempts=5

  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null "$url"; then
      echo "    OK $url (attempt $attempt/$attempts)"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      echo "    not ready $url (attempt $attempt/$attempts); retrying in 3s" >&2
      sleep 3
    fi
  done

  echo "    FAILED $url after $attempts attempts" >&2
  return 1
}

echo "==> Verifying public endpoints through the edge proxy"
for url in \
  https://api.nessie.works/api/health \
  https://app.nessie.works/ \
  https://nessie.works/; do
  verify_public_endpoint "$url"
done

# Post-swap reclaim: the previous release's images are now unreferenced. Each
# deploy pulls a fresh SHA-tagged image, so without this the disk grows by an
# image per deploy on a box shared with ~40 other apps.
echo "==> Reclaiming disk (post-deploy)"
docker builder prune -f --keep-storage 40GB >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

# SHA-tagged release images are NOT dangling, so `image prune` never reclaims
# them and the disk would grow by one full image per deploy. Drop every Nessie
# release image except the one just deployed; Docker refuses to remove an image
# a container still uses, which is the safety net if a rollback is mid-flight.
if [ -n "$NESSIE_IMAGE_TAG" ]; then
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep "^${NESSIE_IMAGE_REPO}-" \
    | grep -v ":${NESSIE_IMAGE_TAG}$" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
fi

echo "==> Status"
docker ps --filter name=nessie --format 'table {{.Names}}\t{{.Status}}'
echo "==> Host disk"
df -h / | tail -1

cat <<'NOTE'

If this is the first deploy (no users yet), grab the one-time owner bootstrap URL:
  docker compose -f infrastructure/compose/docker-compose.prod.yml logs nessie-api 2>&1 | grep bootstrap
Then open https://app.nessie.works/bootstrap?token=<token>
NOTE
