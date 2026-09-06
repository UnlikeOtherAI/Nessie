#!/usr/bin/env bash
# Entrypoint for the Cloud Run migrate job (infrastructure/terraform/modules/job).
#
# This is redeploy.sh's migration section, ported. It runs on the same
# `nessie-app` image the API and worker run, as a command override, and every
# rollout gates on it: no revision takes traffic until this exits 0.
#
# Order matters and is the same as the Hetzner path:
#   1. clear any migration that died mid-deploy and can be replayed,
#   2. prisma migrate deploy,
#   3. App Store catalogue seeds,
#   4. reconcile.
#
# Step 4 is not optional. Boot connects and listens and nothing else
# (docs/standards/horizontal-scaling.md invariant 5), so default policy rules,
# the protected-MCP grant backfill, Personal Assistant default grants and the
# expired-credential sweep happen here or nowhere.
set -euo pipefail

cd /app

echo "==> Nessie migrate job"

# Prisma stops at the first failed migration and refuses every later one
# (P3009), so one migration that died mid-deploy parks the whole installation
# until somebody clears it by hand — production sat un-deployable for a day
# that way.
#
# Listed here are the migrations known to have failed *atomically*: each is
# wholly transactional, so Postgres rolled the entire file back and the
# database is exactly as it was before it ran. Marking one of those rolled-back
# is therefore truthful, and lets `migrate deploy` replay it against a database
# that the repair migration ahead of it has since fixed.
#
# Only add a name here after confirming in the deploy log that it failed on a
# statement inside its transaction, and that something now makes the replay
# succeed. A migration that half-applied (one containing CREATE INDEX
# CONCURRENTLY, say, which cannot run in a transaction) is not a candidate and
# has to be resolved by hand.
RESOLVABLE_FAILED_MIGRATIONS=(
  # Interrupted mid-deploy; replays cleanly.
  20260613100000_channel_project_slugs
  # Failed 22P02 comparing against the enum value that
  # 20260901195000_tool_grant_source_snake_case renames into existence. That
  # repair migration now runs first, so the replay succeeds.
  20260901200000_tool_grant_principal_integrity
)

# The operator's escape hatch, and the reason this job is worth having over a
# bare `prisma migrate deploy`. A migration that parks the deployment TODAY is
# not in the baked list above, and on the Hetzner host clearing it meant
# editing redeploy.sh, committing, and waiting for a build. Here it is one
# execution override:
#
#   gcloud run jobs execute nessie-prod-migrate --region <region> --wait \
#     --update-env-vars NESSIE_MIGRATE_RESOLVE_ROLLED_BACK=<migration_name>
#
# It applies to that execution only; the next deploy runs without it. Confirm
# the rollback before using it — none of the objects the migration creates
# should exist, and anything it alters should still be in its original shape.
if [ -n "${NESSIE_MIGRATE_RESOLVE_ROLLED_BACK:-}" ]; then
  echo "==> Operator override: NESSIE_MIGRATE_RESOLVE_ROLLED_BACK=${NESSIE_MIGRATE_RESOLVE_ROLLED_BACK}"
  IFS=',' read -r -a override_migrations <<<"${NESSIE_MIGRATE_RESOLVE_ROLLED_BACK}"
  for override in "${override_migrations[@]}"; do
    trimmed="$(printf '%s' "$override" | tr -d '[:space:]')"
    if [ -n "$trimmed" ]; then
      RESOLVABLE_FAILED_MIGRATIONS+=("$trimmed")
    fi
  done
fi

# The image has no psql — node:22-slim ships neither the Postgres client nor
# apt sources worth adding one from — so the parked-migration probe goes
# through `pg`, which @nessie/api already depends on. Exit codes: 0 parked,
# 1 not parked, 2 could not tell (a fresh database has no _prisma_migrations
# table yet, which is not an error).
is_parked() {
  (
    cd /app/api
    node -e '
      const { Client } = require("pg")
      const name = process.argv[1]
      const client = new Client({ connectionString: process.env.DATABASE_URL })
      const done = (code) => client.end().catch(() => {}).finally(() => process.exit(code))
      client
        .connect()
        .then(() =>
          client.query(
            "SELECT 1 FROM _prisma_migrations WHERE migration_name = $1 AND finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1",
            [name],
          ),
        )
        .then((result) => done(result.rowCount > 0 ? 0 : 1))
        .catch(() => done(2))
    ' "$1"
  )
}

for migration in "${RESOLVABLE_FAILED_MIGRATIONS[@]}"; do
  set +e
  is_parked "$migration"
  parked=$?
  set -e

  case "$parked" in
    0)
      echo "==> Marking failed migration $migration for retry"
      pnpm --filter @nessie/api run prisma:migrate:resolve-rolled-back "$migration"
      ;;
    2)
      echo "    could not check $migration (no migration history yet) — skipping"
      ;;
    *) ;;
  esac
done

echo "==> Applying database migrations"
pnpm --filter @nessie/api prisma:migrate:deploy

# The App Store's first-party rows are seeded by migration, but their curated
# copy, categories, trust and Featured flags — and the two curated connectors —
# come from these. Both are idempotent upserts keyed on stable ids and both
# preserve any field a curator has since edited. The ~5,500 registry apps are
# NOT seeded here; that is the worker's scheduled sync.
echo "==> Seeding App Store catalogue"
pnpm --filter @nessie/api seed:connectors
pnpm --filter @nessie/api seed:apps

echo "==> Reconciling policy defaults and tool grants"
pnpm --filter @nessie/api reconcile

echo "==> Migrate job complete"
