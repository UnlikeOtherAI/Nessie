-- Default policy rules become identifiable, so concurrent seeders converge on
-- one default set instead of inserting it once per racing boot.
--
-- `seed_key` is NULL for every rule a person authored. Uniqueness is over this
-- key and deliberately NOT over the rule's semantic columns, because two
-- hand-written rules may legitimately differ only in `conditions` or `priority`
-- and a semantic unique index would refuse the second one.
ALTER TABLE "policy_rules" ADD COLUMN IF NOT EXISTS "seed_key" TEXT;

-- >>> collapse-default-policy-duplicates
-- Collapse the duplicates the pre-fix count-then-create left behind, and stamp
-- the surviving row with its seed key.
--
-- Matching is by the exact shape the seeder wrote, never anything looser: the
-- organisation scope pinned to the organisation itself, the
-- resource/action/effect/priority quadruple the seeder used, no `conditions`,
-- and exactly one binding — a `role` binding naming that default's actor. A row
-- matching all of that is behaviourally identical to the default, so keeping
-- the oldest (`created_at`, then `id`) and deleting the rest changes no
-- permission answer; it only removes the equal-priority ties that made
-- `resolveDecision` order-dependent. A rule carrying conditions, a second
-- binding, a different priority or a different actor is somebody's own rule and
-- is left untouched.
--
-- Idempotent: only rows still unstamped (`seed_key IS NULL`) are considered, so
-- a replay after a rolled-back deploy is a no-op. The same statement is
-- extracted between these markers by
-- `api/test/policy-seed-race-db.test.ts`, which applies it to an organisation
-- seeded twice through the pre-fix path.
WITH "defaults" ("seed_key", "resource_type", "action", "effect", "priority", "actor_id") AS (
  VALUES
    ('default:knowledge_space:view:allow:*'::text, 'knowledge_space'::text, 'view'::text, 'allow'::text, 100, '*'::text),
    ('default:knowledge_space:create:allow:*', 'knowledge_space', 'create', 'allow', 100, '*'),
    ('default:knowledge_space:edit:allow:*', 'knowledge_space', 'edit', 'allow', 100, '*'),
    ('default:knowledge_page:view:allow:*', 'knowledge_page', 'view', 'allow', 100, '*'),
    ('default:knowledge_page:create:allow:*', 'knowledge_page', 'create', 'allow', 100, '*'),
    ('default:knowledge_page:edit:allow:*', 'knowledge_page', 'edit', 'allow', 100, '*'),
    ('default:knowledge_page:read:allow:*', 'knowledge_page', 'read', 'allow', 100, '*'),
    ('default:knowledge_page:search:allow:*', 'knowledge_page', 'search', 'allow', 100, '*'),
    ('default:knowledge_page:approve:allow:owner', 'knowledge_page', 'approve', 'allow', 10, 'owner'),
    ('default:agent:bind:deny:member', 'agent', 'bind', 'deny', 50, 'member'),
    ('default:agent:bind:allow:owner', 'agent', 'bind', 'allow', 10, 'owner'),
    ('default:channel:view:allow:*', 'channel', 'view', 'allow', 100, '*'),
    ('default:admin:admin:deny:member', 'admin', 'admin', 'deny', 50, 'member'),
    ('default:admin:admin:allow:owner', 'admin', 'admin', 'allow', 10, 'owner'),
    ('default:agent:view:allow:*', 'agent', 'view', 'allow', 100, '*'),
    ('default:agent:invoke:allow:*', 'agent', 'invoke', 'allow', 100, '*'),
    ('default:tool:view:allow:*', 'tool', 'view', 'allow', 100, '*')
),
"matched" AS (
  SELECT
    "r"."id" AS "rule_id",
    "d"."seed_key" AS "seed_key",
    row_number() OVER (
      PARTITION BY "r"."organization_id", "d"."seed_key"
      ORDER BY "r"."created_at", "r"."id"
    ) AS "rank"
  FROM "policy_rules" "r"
  JOIN "defaults" "d"
    ON "d"."resource_type" = "r"."resource_type"::text
   AND "d"."action" = "r"."action"::text
   AND "d"."effect" = "r"."effect"::text
   AND "d"."priority" = "r"."priority"
  WHERE "r"."seed_key" IS NULL
    AND "r"."scope" = 'organization'
    AND "r"."scope_id" = "r"."organization_id"::text
    AND "r"."conditions" IS NULL
    AND (
      SELECT count(*) FROM "policy_bindings" "b" WHERE "b"."policy_rule_id" = "r"."id"
    ) = 1
    AND EXISTS (
      SELECT 1 FROM "policy_bindings" "b"
      WHERE "b"."policy_rule_id" = "r"."id"
        AND "b"."actor_type" = 'role'
        AND "b"."actor_id" = "d"."actor_id"
    )
),
-- Postgres runs a data-modifying CTE to completion whether or not the primary
-- query reads it, and the two row sets are disjoint (`rank` > 1 versus = 1), so
-- no row is both deleted and updated by this statement.
"collapsed" AS (
  DELETE FROM "policy_rules"
  WHERE "id" IN (SELECT "rule_id" FROM "matched" WHERE "rank" > 1)
  RETURNING "id"
)
UPDATE "policy_rules" "r"
SET "seed_key" = "m"."seed_key"
FROM "matched" "m"
WHERE "r"."id" = "m"."rule_id"
  AND "m"."rank" = 1
  AND "r"."seed_key" IS NULL;
-- <<< collapse-default-policy-duplicates

-- The guarantee behind race-free seeding. The per-organisation advisory lock in
-- `seedDefaultPolicies` is only the optimisation that keeps the losers from
-- doing the work; this index is what makes a concurrent
-- `createMany({ skipDuplicates: true })` land exactly one row per default.
-- Partial, so the NULL `seed_key` of every hand-authored rule is not indexed
-- and never constrained.
CREATE UNIQUE INDEX IF NOT EXISTS "policy_rules_organization_id_seed_key_key"
  ON "policy_rules" ("organization_id", "seed_key")
  WHERE "seed_key" IS NOT NULL;
