# Deploy readiness — 2026-08-15 UOA SSO + org-tenancy release

> **Status:** assessed, **ready with conditions** (see §6). PREPARATION ONLY —
> nothing in this document has been executed against production. Rehearsals ran
> against throwaway `pgvector/pgvector:pg17` containers on a dev machine,
> restored from `api/prisma/upgrade-fixtures/baseline.sql.gz`.
> **Target commit:** `ee334d7c` (main, 2026-08-15, "merge: billing SSO/contract
> audit"). Everything reachable from `main` up to that commit is in scope.
> **Deploy mechanism:** push to `main` → `.github/workflows/deploy.yml` → rsync
> to `/srv/nessie` → `infrastructure/compose/redeploy.sh` on the Hetzner host
> (178.105.82.46). No manual step outside that script is required.

## What this release changes

One merge window carries the whole UOA SSO change set:

- **Subject keying** — `users.uoa_sub` + unique index, backfilled from linked
  `product_account_links` (commit `feat(db): user uoa subject keying`).
- **Org-per-UOA-org tenancy** — `organizations.external_org_id` + unique index,
  then the partition migration that splits the flattened shared Organization
  into one per UOA organisation (`b3f39a16`, `0e756507`).
- **Roles from claims** — `OrganizationMember.role` is projected from the UOA
  `org_role` claim; local membership mutation routes refuse non-local mode
  (`membership-mode-gate.ts`).
- **Rosters/invitations** — `/api/workspace/members` +
  `/api/workspace/invitations*` relay live to UOA's `/org/*` backend-mode API
  (`workspace-members.ts`, `@nessie/workspace-admin/uoa-org-roster`).
- **Profile mirror** — display name/avatar authority moved to UOA.
- **Switch reauth** — cross-organisation workspace switches confirm direct
  access at UOA before re-binding the session
  (`uoa-workspace-switch.ts` → `confirmUoaDirectServiceAccess`).
- **Directory cache** — the durable `workspaceDirectory` mirror is dropped from
  `product_account_links.metadata_json`; directory data now lives only in the
  API's bounded in-memory cache (30 min TTL, 10k users).

## 1. Migrations that will run, in order

The production database was last migrated when the deploy workflow last ran.
`baseline.sql.gz` records `20260722033000_nessie_account_link_product` as the
cut point — i.e. production is *at least* at that migration, and HEAD has **49
migrations** beyond it. Any subset already applied is skipped by
`prisma migrate deploy`; the rehearsal below applied all 49.

### 1a. Rehearsal results (measured, this worktree)

**Run 1 — empty baseline.** Restored fixture (130 migrations recorded, 0 data
rows), applied all 49. Total DB-side time **~241 ms**; slowest was the
partition migration at **89 ms**. `api/scripts/upgrade-smoke.mjs`: **PASS**
(178/178 applied).

**Run 2 — production-shaped data.** Restored fixture, then seeded the flattened
pre-partition model: one shared Organization; two UOA orgs of teams
(`uoa-org-A` plurality → adopter, `uoa-org-B` → split); **200,000 messages**,
**10,000 threads**, **200,000 audit_logs rows** hanging off the split org's
team/channel, plus users, memberships, agents, and a `nessie`
`product_account_links` row carrying a `workspaceDirectory` key. Applied all
49 migrations with `prisma migrate deploy`:

- **Total wall time: 4.1 s** (including Prisma client startup).
- `20260815180000_partition_uoa_organizations`: **3.23 s** — moved the split
  org's channel/agent/audit subtree (verified: `orgs=2`, all 200k audit rows
  re-tenanted to the new org, `organization_members` seeded at GREATEST role
  `admin` for the split-only user, all 200k audit `prev_hash`/`entry_hash`
  NULLed by the epoch reset).
- Everything else ≤ 71 ms each (`20260724160000_reply_threads` 71 ms,
  `20260806150000_tenant_scope_foreign_keys` 42 ms, the rest single-digit ms).
- Post-migration smoke: **PASS** (`users=2, organizations=2, messages=200000,
  auditLogs=200000`).
- `users.uoa_sub` backfill verified: the linked user got `uoa-sub-alice`, the
  unlinked user stayed NULL (claimed at next UOA login).

**Caveat on scale.** The benchmark host is a dev machine, not the Hetzner box,
and 200k rows is a stand-in for "production-sized". The partition migration's
cost is linear in the number of rows reachable from a moved project/team/
channel/agent/thread subtree (each `UPDATE ... FROM _moved_*` is an indexed
join on a small temp set); the rehearsal's 200k-row sweeps cost ~3 s, so a
production table in the low millions should land in the tens of seconds. All
row moves run in **one transaction** — Postgres holds row locks on touched
rows and a brief lock for each DDL statement, but there is no table-wide lock
on `messages`/`runs`/`audit_logs` beyond the rows actually rewritten. The
migration's own header states the guards that make a partially-adopted state
safe to re-run.

**Structural preconditions the migration enforces loudly** (from the SQL, not
assumed):

- A project containing teams of two distinct UOA external orgs aborts with a
  named exception before any row moves (§0 of the migration). **Operator
  pre-check below.**
- Adoption never overwrites an already-set `external_org_id`; a pre-existing
  Organization bound to a split external id is reused rather than duplicated.

### 1b. The 49 migrations, grouped

| # | Migration | What it does to existing data | Cost class |
|---|-----------|-------------------------------|------------|
| 1 | `20260723000000_audit_hash_chain` | Adds `prev_hash`/`entry_hash` columns to `audit_logs` (no backfill — pre-chain rows keep NULL hashes, verifier treats them as genesis) | instant (metadata-only ADD COLUMN) |
| 2 | `20260723120000_add_run_lifecycle_controls` | New columns/tables for run pause/cancel lifecycle | instant |
| 3 | `20260723120000_budget_alerts` | New `budget_alerts` table | instant |
| 4 | `20260724120000_auth_rate_limit_buckets` | New `rate_limit_buckets` table | instant |
| 5 | `20260724150000_user_alerts` | New `user_alerts` table | instant |
| 6 | `20260724160000_reply_threads` | Adds reply-thread columns (`root_message_id`, `reply_count`, `last_reply_at`, `reply_participant_ids`) to `messages` + a plain (non-CONCURRENTLY) index on `messages(root_message_id, created_at)` and new `message_thread_follows` table; measured 71 ms at 200k messages. The two `NOT NULL DEFAULT` columns are metadata-only rewrites on PG 11+. | fast |
| 7 | `20260724170000_org_strip_image_metadata` | `organizations.strip_image_metadata` column | instant |
| 8 | `20260724190000_run_thread_serialization` | New `run_thread_pending_messages` table + FKs | instant |
| 9 | `20260805103000_run_limits_and_checkpoints` | `agents.run_limits`, `runs.continuation_of_run_id`, new `run_checkpoints` | instant |
| 10 | `20260805120000_reply_placement_and_thinking_chunks` | New `run_thinking_chunks` table, reply-placement columns | instant |
| 11 | `20260806090000_attachment_thumbnails` | thumbnail columns on `attachments` | instant |
| 12 | `20260806140000_session_revocation_and_policy_index` | session-revocation column + policy index | instant |
| 13 | `20260806150000_tenant_scope_foreign_keys` | **Guarded orphan sweep (`DELETE` of rows whose organization/project no longer exists) then ~40 `ADD CONSTRAINT` FKs across org-scoped tables.** On clean data every DELETE is a no-op; on dirty data it deletes rows that are already unreachable. Each ADD CONSTRAINT takes a lock on the child table while it validates. | measured 42 ms empty; scales with validation time — FK validation scans the child table once each |
| 14 | `20260806160000_restore_thoughts_search_indexes` | Recreates the `thoughts` GIN full-text/metadata indexes (`IF NOT EXISTS`) that an earlier drift reconciliation dropped; restores indexed lexical memory recall | GIN index builds on `thoughts` — brief lock, no data change |
| 15 | `20260811120000_embeddings_1024_dimensions` | **DISCARDS all existing embeddings** (`thoughts.embedding`, `thought_recalls.query_embedding`, `knowledge_page_chunks.embedding` → NULL), re-types the three columns `vector(1536)` → `vector(1024)`, drops + recreates the HNSW index. Re-embedding happens naturally afterwards; recall degrades to lexical until then. | measured 13 ms; linear in non-null vector rows (UPDATE sweep) |
| 16 | `20260811130000_scope_device_tokens_by_organization` | org scoping on `device_tokens` | instant |
| 17–20 | `20260811133/114/1143…` device-token migrations | APNs environment column, single-owner constraint, registration ordering | instant |
| 21 | `20260811150000_user_push_surface_presence` | New `user_push_surface_presence` table | instant |
| 22 | `20260811220000_push_attention_management` | push attention columns/indexes | instant |
| 23 | `20260812090000_disclosure_basis_ledger` | disclosure basis ledger tables | instant |
| 24–31 | `20260812100000`–`20260812170000` executor migrations | Executor persistence/tool-registry/pairing/daemon-challenge tables + transport enum | instant (all new tables; heaviest measured 30 ms) |
| 25b | `20260812140000_disclosure_grants` | New `disclosure_grants` / `scope_disclosure_grants` tables | instant |
| 32 | `20260812180000_workflow_graph_snapshots_and_step_leases` | workflow snapshot + step-lease tables | instant |
| 33 | `20260812190000_workflow_run_retry_actor` | retry-actor column on workflow runs | instant |
| 34 | `20260812200000_workflows_message_send_cas_overlap` | CAS guard for workflow message sends | instant |
| 35 | `20260812201000_push_surface_thread_presence` | thread presence columns | instant |
| 36 | `20260813100000_agent_avatar_background` | `agents.avatar_background_color` | instant |
| 37 | `20260813120000_workflow_template_step_samples` | template sample column | instant |
| 38 | `20260813121000_push_surface_reply_root_presence` | reply-root presence column | instant |
| 39 | `20260813150000_message_conversation_read_states` | New `message_conversation_read_states` table | instant |
| 40 | `20260814090000_workflow_run_origin` | durable `origin` on `workflow_runs` | instant |
| 41 | `20260814100000_live_data_dashboards` | New dashboard tables (data sources, datasets, widgets, versions, snapshots, grants, embed placements) | instant (all new tables) |
| 42 | `20260814120000_live_document_streaming` | New `run_document_sessions` / `run_document_chunks` tables | instant |
| 43 | `20260814130000_uoa_workspace_switch_intents` | **New** `uoa_workspace_switch_intents` table + 2 FKs | instant |
| 44 | `20260814140000_refresh_token_user_session_lookup` | New index on `refresh_tokens(user_id, session_id)` — plain `CREATE INDEX`, **not** `CONCURRENTLY`, on a hot table. Brief lock; the table is small (one row per active refresh), so cost is negligible, but it does lock writes for the build. | fast |
| 45 | `20260815090000_user_uoa_subject_keying` | Adds `users.uoa_sub` + unique index; **backfills** from `product_account_links` (guarded: ambiguous subjects/users stay NULL). Rows without a link are untouched and claim at next UOA login. | measured 3 ms; one UPDATE over `users` joined to links |
| 46 | `20260815120000_drop_uoa_workspace_directory_mirror` | Removes the `workspaceDirectory` key from `product_account_links.metadata_json` (jsonb `-` operator; every other key preserved) | linear in `product_account_links` rows (small) |
| 47 | `20260815170000_organization_external_org_id` | Adds `organizations.external_org_id` + unique index; no data change | instant |
| 48 | `20260815180000_partition_uoa_organizations` | **The data migration.** See §1a and §4. Moves rows across ~60 tables for split UOA orgs, seeds `organization_members` for moved-team users at their greatest team role, moves account links for users with no remaining old-org membership, NULLs the audit hash-chain for every org a split touched. On a single-UOA-org install it is a **pure adoption**: sets `organizations.external_org_id` and moves nothing. | measured 3.23 s moving a 200k-audit-row subtree; linear in moved-subtree size |

**Non-`CONCURRENTLY` index note:** `pnpm lint:migrations` warns only for the
known-large tables (`messages`/`task_events`/`runs`/`audit_logs`); one plain
index does land on `messages(root_message_id, created_at)` (migration 6) —
measured 71 ms over 200k rows in the rehearsal, so even at low-millions of
rows it is a sub-second lock. The `refresh_tokens` (44) and `users` (45)
unique-index builds are on small tables and complete in milliseconds.

## 2. Config / env changes

**None required.** Verified against the repo:

- `org_features.backend_org_management: true` is **hardcoded** in
  `buildConfigJwt` (`api/src/services/uoa-auth.ts`), served from
  `GET /api/auth/sso/config`. Verified by building and decoding a real config
  JWT with a throwaway RS256 key on this commit:
  ```json
  "org_features": {
    "enabled": true,
    "allow_user_create_org": true,
    "allow_user_create_team": true,
    "backend_org_management": true
  }
  ```
  Because UOA fetches the config URL live, the new claim is picked up by the
  next UOA read after the API container recreates — **no UOA-side re-approval
  and no host `.env` change**. If UOA has cached the old config, roster/invite
  relays will answer `401 MISSING_ACCESS_TOKEN` until the cache refreshes;
  re-fetching the config URL (or waiting out UOA's cache TTL) clears it.
- **No new environment variables.** `git log` on `packages/config`,
  `nessie.config.json`, `.env.prod.example`, and `docker-compose.prod.yml`
  shows no changes in the release window; the roster relay uses the existing
  `UOA_BASE_URL` / `UOA_DOMAIN` / `UOA_CLIENT_SECRET` settings. The directory
  cache is in-memory only — nothing to provision.
- The deploy workflow's dedicated-secret validators (`LEDGER_PROXY_TOKEN`,
  `DEEPSIGNAL_MCP_APP_KEY`, UOA billing keys) are unchanged and unaffected.

## 3. Ordered operator commands

The default path is the GitHub Actions deploy on push to `main`. The ordered
manual equivalent (for an operator driving by hand, or verifying what the
workflow did) is:

```sh
# 0. PRE-CHECKS (from any machine with psql against nessie-postgres, or on the host)
docker compose -f infrastructure/compose/docker-compose.prod.yml exec -T nessie-postgres \
  psql -U nessie -d nessie -tAc "
    SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;   -- expect 0
    SELECT max(migration_name) FROM _prisma_migrations;                   -- expect >= 20260722033000
  "
# Partition precondition: no project may mix teams of two UOA orgs (expect 0 rows)
docker compose -f infrastructure/compose/docker-compose.prod.yml exec -T nessie-postgres \
  psql -U nessie -d nessie -tAc "
    SELECT p.id FROM projects p JOIN teams t ON t.project_id = p.id
    WHERE t.external_org_id IS NOT NULL
    GROUP BY p.id HAVING count(DISTINCT t.external_org_id) > 1;
  "
# How many UOA orgs will split out (informational — 0 or 1 extra row per split org)
docker compose -f infrastructure/compose/docker-compose.prod.yml exec -T nessie-postgres \
  psql -U nessie -d nessie -tAc "
    SELECT t.external_org_id, count(*) FROM teams t
    JOIN projects p ON p.id = t.project_id
    WHERE t.external_org_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;
  "

# 1. BACKUP — the only true rollback for the partition step (see §4)
docker compose -f infrastructure/compose/docker-compose.prod.yml exec -T nessie-postgres \
  pg_dump -U nessie -d nessie -Fc > /srv/nessie/backups/nessie-pre-org-tenancy-$(date +%Y%m%d-%H%M).dump
# MinIO volume (nessie_miniodata) is NOT touched by this release; a pg_dump is sufficient.

# 2. DEPLOY (the scripted path — workflow runs exactly this over SSH)
cd /srv/nessie && bash infrastructure/compose/redeploy.sh
#   - ensures nessie-postgres up, waits pg_isready
#   - builds images (lint-gated Dockerfiles)
#   - runs prisma migrate deploy   ← all 49 migrations, incl. partition
#   - recreates api + worker + admin + web
#   - prunes build cache

# 3. HEALTH CHECKS (in order)
curl -fsS https://api.nessie.works/api/health            # {"data":{"service":"api","status":"ok"}}
curl -fsS https://api.nessie.works/api/auth/providers    # SSO provider listed
curl -fsS https://app.nessie.works/healthz               # ok
docker ps --filter name=nessie --format '{{.Names}} {{.Status}}'   # all healthy
docker logs nessie-worker 2>&1 | tail -5                 # "status":"ready"
docker logs nessie-api 2>&1 | grep -i "ledger identity\|signing" | tail -2  # confirm signing mode line

# 4. MIGRATION VERIFICATION
docker compose -f infrastructure/compose/docker-compose.prod.yml exec -T nessie-postgres \
  psql -U nessie -d nessie -tAc "
    SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;        -- 0
    SELECT count(*) FROM organizations WHERE external_org_id IS NOT NULL;      -- >= 1 (was 0)
    SELECT id, name, external_org_id FROM organizations ORDER BY created_at;   -- adopting org keeps its row/name
    SELECT migration_name, finished_at - started_at AS took FROM _prisma_migrations
      WHERE migration_name='20260815180000_partition_uoa_organizations';
  "

# 5. CONFIG JWT VERIFICATION (the release's load-bearing claim)
curl -fsS https://api.nessie.works/api/auth/sso/config | cut -d. -f2 | base64 -d 2>/dev/null | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['org_features'])"
#   expect: {'enabled': True, 'allow_user_create_org': True, 'allow_user_create_team': True,
#            'backend_org_management': True}
```

## 4. Rollback plan, per step

| Step | Rollback | Reversible? |
|------|----------|-------------|
| Pre-checks | read-only; nothing to roll back | n/a |
| Backup | n/a | n/a |
| Image build | old images still on the host until the prune at the end of `redeploy.sh`; retag/repoint if needed | yes |
| `prisma migrate deploy` — migrations 1–47 | Schema-only or additive: columns/tables/indexes the old code ignores. Rolling back to the previous image is safe **without** a database restore. The one exception with data impact is `20260811120000_embeddings_1024_dimensions`, which NULLs all stored vectors; that is permanent data loss *of a cacheable artifact* — rows re-embed naturally and recall degrades to lexical in the meantime. No restore needed for correctness. | mostly yes (embeddings NULL is one-way but self-healing) |
| `20260815180000_partition_uoa_organizations` | **NOT reversible by redeploy.** It rewrites `organization_id` on the moved subtree across ~60 tables and seeds new `Organization` / `organization_members` rows; there is no inverse migration and none should be written ad hoc. Rolling back the *image* afterwards leaves old code reading a per-org-tenanted database: the old code resolves the shared org by globally-oldest `Organization` and will mis-scope split-org users. **The only true rollback is `pg_restore` of the step-1 dump onto a fresh volume + redeploying the previous image.** Cost: the dump/restore is the size of the whole database (minutes to tens of minutes of downtime on a production-sized volume), and **all writes between the deploy and the restore are lost** — they live only in the post-partition database. This is why step 1 is mandatory and why the deploy should be scheduled so a restore window is acceptable. | **NO — restore-only** |
| Container recreate (`up -d`) | `docker compose up -d --force-recreate` with the previous image tag; safe only if the partition migration has **not** run yet | yes (pre-partition only) |
| Caddy | untouched by this release | n/a |

**Failed-migration recovery.** `prisma migrate deploy` runs each migration in a
transaction; a failure leaves the row in `_prisma_migrations` with
`finished_at NULL` and rolls the migration's own work back. Fix the cause
(partition precondition failure → resolve the mixed project by hand), then
mark the attempt rolled back and re-run:

```sh
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm --no-deps api \
  pnpm --filter @nessie/api exec prisma migrate resolve \
  --rolled-back 20260815180000_partition_uoa_organizations --schema prisma/schema.prisma
docker compose -f infrastructure/compose/docker-compose.prod.yml run --rm --no-deps api \
  pnpm --filter @nessie/api prisma:migrate:deploy
```

## 5. Post-deploy smoke checklist

| # | Check | How | "Good" looks like |
|---|-------|-----|-------------------|
| 1 | Login | `https://app.nessie.works` → Sign in with SSO | UOA renders, callback returns, lands in the app. A user whose workspaces stayed in the adopting org is **still signed in** (no login needed). A user in a split org is asked to log in **once**, then lands normally — this is expected, not a bug. |
| 2 | Workspace switch | Workspace switcher → pick a workspace in the *other* UOA org | Switch completes (possibly via one UOA reauth), lands on `/channels`, channels/threads of the target workspace render. `resolveUoaWorkspaceContext` resolves 1:1 by `externalOrgId` — no cross-org rows. |
| 3 | Roster read | Members page (or `GET /api/workspace/members`) | UOA roster rows render with names/avatars; member (non-owner) can read; `GET` succeeds only when the config JWT carries `backend_org_management` — a 401 here means UOA is still serving the cached old config (see §2). |
| 4 | Invite | Members → invite an email (owner/admin) | UOA sends the invitation; it appears in `GET /api/workspace/invitations`. A non-owner attempting it gets 403 from Nessie's own gate. |
| 5 | Revoke | Members → revoke that invitation | `{ ok: true }`, invitation gone from the list. Revoking an already-accepted invite answers `409 INVITATION_ALREADY_ACCEPTED` (that person is a member now — removal is the verb). |
| 6 | Tenancy sanity | psql: `SELECT external_org_id, count(*) FROM teams GROUP BY 1` vs the same grouped by `projects.organization_id` | every team's `external_org_id` matches its organization's binding; no team in an org bound to a different external id. |
| 7 | Audit chain | `packages/db` audit-chain verifier over each org | verifies; first post-partition row per org is genesis (both hashes NULL is the pre-chain epoch state the verifier models). |
| 8 | Agent run | send a message that triggers an agent in each org | run completes; `docker logs nessie-worker` shows no `Memory search failed` / embedding errors beyond the known re-embedding window. |

## 6. Blockers / conditions

1. **SPLIT-ORG RE-LOGIN IS USER-VISIBLE.** If production hosts more than one
   UOA organisation (check with the §3 pre-check query: more than one
   `external_org_id` row returned), users in every non-adopting org are forced
   through one re-login at their next visit. Expected and one-time, but it
   must be communicated before the deploy. **Not a blocker if production is
   single-org** — then the partition is adoption-only and moves nothing.
2. **Take the pg_dump first (step 1).** The partition migration is
   restore-only-rollback. Deploying without a fresh dump is the one thing that
   would make this release unsafe. **Blocker if skipped.**
3. **UOA config cache.** Roster/invite routes depend on UOA having re-read the
   config JWT with `backend_org_management: true`. If UOA caches aggressively,
   the Members page can 401 briefly after deploy. Mitigation: re-validate
   (`POST <uoa>/config/validate`) or wait out the cache; no code change needed.
   **Condition, not blocker.**
4. **Mixed-project precondition.** If the §3 pre-check returns any project, the
   partition migration will *fail loudly* (by design) and the deploy stops
   mid-chain. Resolve the mixed project first. Expected to return zero rows —
   the flattened model always provisioned one Project+Team per workspace —
   but check. **Blocker only if it returns rows.**
5. **Embeddings are re-nulling (if not already applied).** If production has
   not yet taken `20260811120000_embeddings_1024_dimensions`, this deploy
   discards all stored vectors; recall is lexical-only until re-embedding
   catches up. Known, self-healing, documented in `docs/deployment.md`.
   **Not a blocker.**

No code-level blocker found in this assessment: the migration chain is proven
against the checked-in baseline fixture at 200k-row scale (4.1 s total), the
config JWT carries the required claim, and no new env var exists to forget.
