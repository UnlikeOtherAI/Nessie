# Supported upgrade paths and stuck migrations

Chapter of [deployment.md](../deployment.md). What `prisma migrate deploy` is proven to converge from, how one failed migration parks every deploy after it, and the per-UOA-org partition.

## Supported upgrade paths

Upgrades are applied by `prisma migrate deploy` against the existing database
(see `redeploy.sh`), followed by the seeds and then
`pnpm --filter @nessie/api reconcile`. That last step is not optional: default
policy rules, protected-MCP tool grants, Personal Assistant default grants and
the expired-credential sweep used to run on every API replica at boot and now
run once per deploy, because boot connects and listens and nothing else
([standards/horizontal-scaling.md](../standards/horizontal-scaling.md) §5). An
upgrade that applies the migrations by hand must run the reconcile job too, or
organisations provisioned by an older release keep denying knowledge actions and
agent binds. It is idempotent, so running it again is free.

CI proves the migration path works for the route self-hosters actually take — a
database sitting on an older schema, not a fresh dev database:

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

### A failed migration parks every deploy after it

`prisma migrate deploy` stops at the first failed migration and refuses every
later one with **P3009**, so one bad migration takes the whole installation
out of service until somebody clears it — production spent a day rejecting
every deploy this way when
`20260901200000_tool_grant_principal_integrity` died on `22P02` (it compared
against an enum value that did not exist yet; `20260901195000_tool_grant_source_snake_case`
is the repair, and now runs before it).

`redeploy.sh` clears such a migration itself, from the
`RESOLVABLE_FAILED_MIGRATIONS` list near the top: for each name it asks
`_prisma_migrations` whether that migration is parked (`finished_at IS NULL AND
rolled_back_at IS NULL`), and if so runs `prisma migrate resolve --rolled-back`
before migrating. The check makes the block a no-op on a healthy database, so
the list is safe to keep.

Only add a name to that list once the deploy log shows the migration failed on
a statement **inside its transaction** — Postgres then rolled the whole file
back and the database is untouched, which is what makes `--rolled-back` the
truthful answer — and something now makes the replay succeed. Confirm the
rollback rather than assuming it: none of the objects the migration creates
should exist, and any object it alters should still be in its original shape.
A migration that half-applied (one containing `CREATE INDEX CONCURRENTLY`, say,
which cannot run in a transaction) is **not** a candidate and has to be
resolved by hand against the real database.

### One-time: per-UOA-organisation tenancy (2026-08-15)

Nessie keeps **one `Organization` per UOA organisation**
(`Organization.externalOrgId`) instead of one shared local organisation holding
every team. The partition migration runs with the others at deploy
(`prisma migrate deploy`, i.e. `redeploy.sh`) and needs no operator action. The
existing organisation adopts the UOA organisation most of its teams belong to
(ties go to the oldest team's), so nothing moves for the common
single-organisation install; any *other* UOA organisation splits into its own
`Organization` with its project/team subtrees and memberships, while org-global
rows (settings, logo, unattributable audit rows) stay with the adopting one.
**Users whose teams split off sign in once after the deploy** — a session
is bound to the organisation it was issued for, and the refresh family re-homes
at that login. Plan the deploy accordingly if you host more than one UOA
organisation.

Background, migration rules, and verification:
[plans/2026-08-15-uoa-org-tenancy.md](../plans/2026-08-15-uoa-org-tenancy.md).
