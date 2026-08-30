#!/usr/bin/env bash
# Rebuild + redeploy Nessie on the host after the source tree has been rsync'd
# to /srv/nessie. Run from /srv/nessie. Postgres and its volume are left intact.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f infrastructure/compose/docker-compose.prod.yml"

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

FAILED_CHANNEL_SLUG_MIGRATION="$(
  $COMPOSE exec -T nessie-postgres psql -U nessie -d nessie -tAc \
    "SELECT 1 FROM _prisma_migrations WHERE migration_name = '20260613100000_channel_project_slugs' AND finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1;" \
    2>/dev/null | tr -d '[:space:]' || true
)"
if [ "$FAILED_CHANNEL_SLUG_MIGRATION" = "1" ]; then
  echo "==> Marking interrupted channel slug migration for retry"
  $COMPOSE run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:resolve-rolled-back-channel-slugs
fi

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

echo "==> Recreating api + worker + admin + web"
$COMPOSE up -d

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
  docker logs nessie-api 2>&1 | grep bootstrap
Then open https://app.nessie.works/bootstrap?token=<token>
NOTE
