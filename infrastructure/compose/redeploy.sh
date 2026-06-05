#!/usr/bin/env bash
# Rebuild + redeploy Nessie on the host after the source tree has been rsync'd
# to /srv/nessie. Run from /srv/nessie. Postgres and its volume are left intact.
set -euo pipefail

cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f infrastructure/compose/docker-compose.prod.yml"

echo "==> Ensuring Postgres is up"
$COMPOSE up -d postgres

echo "==> Building images (api + admin)"
$COMPOSE build api admin

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
