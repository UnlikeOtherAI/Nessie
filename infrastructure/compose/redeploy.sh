#!/usr/bin/env bash
# Rebuild + redeploy Nessie on the host after the source tree has been rsync'd
# to /srv/nessie. Run from /srv/nessie. Postgres and its volume are left intact.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f infrastructure/compose/docker-compose.prod.yml"

echo "==> Ensuring Postgres is up"
$COMPOSE up -d nessie-postgres

echo "==> Building images (api + admin)"
$COMPOSE build api admin

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

echo "==> Applying database migrations"
$COMPOSE run --rm --no-deps api pnpm --filter @nessie/api prisma:migrate:deploy

echo "==> Recreating api + worker + admin"
$COMPOSE up -d

echo "==> Status"
docker ps --filter name=nessie --format 'table {{.Names}}\t{{.Status}}'

cat <<'NOTE'

If this is the first deploy (no users yet), grab the one-time owner bootstrap URL:
  docker logs nessie-api 2>&1 | grep bootstrap
Then open https://nessie.unlikeotherai.com/bootstrap?token=<token>
NOTE
