-- Session revocation + the hot authorization index.
--
-- 1. `users.token_version` is minted into each access token as the `tv` claim
--    and compared on every authenticated request. Revoking the refresh-token
--    family on logout left the already-issued access token valid for the rest
--    of its TTL; bumping this column closes that window immediately. NOT NULL
--    with a constant DEFAULT, which PostgreSQL 11+ stores in the catalog
--    without rewriting the table.
--
-- 2. `policy_rules` is read on every tool invocation, filtered by
--    (organization_id, resource_type, action, scope_id) and ordered by
--    priority. The existing indexes lead with `scope` or cover only
--    `scope_id`, so neither serves that predicate.
--
--    PRODUCTION: `policy_rules` is small (seeded defaults plus per-org rules),
--    so a plain CREATE INDEX is a short lock. Prisma runs migrations inside a
--    transaction, where CONCURRENTLY is not permitted; if this table has grown
--    large on a given deployment, build the index CONCURRENTLY out of band
--    first and this statement becomes a no-op.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "policy_rules_organization_id_resource_type_action_scope_id_idx"
  ON "policy_rules" ("organization_id", "resource_type", "action", "scope_id", "priority");
