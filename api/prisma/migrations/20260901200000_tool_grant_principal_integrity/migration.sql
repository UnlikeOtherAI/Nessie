-- A direct ToolGrant has no meaning after its agent has gone away. Cascade it
-- rather than nulling agent_id: the exact-one-principal invariant below makes
-- that former nullable relationship invalid by design.
ALTER TABLE "tool_grants"
  DROP CONSTRAINT "tool_grants_agent_id_fkey";

ALTER TABLE "tool_grants"
  ADD CONSTRAINT "tool_grants_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Historic writers predate the one-principal invariant. A row with both
-- principals keeps the principal its durable provenance names; a row with no
-- principal cannot authorize anything and is removed. This happens before the
-- constraint is validated, so upgrading a long-lived installation succeeds
-- without carrying malformed policy rows indefinitely.
UPDATE "tool_grants"
SET "role_id" = NULL
WHERE "agent_id" IS NOT NULL
  AND "role_id" IS NOT NULL
  AND "source" = 'agent_override';

UPDATE "tool_grants"
SET "agent_id" = NULL
WHERE "agent_id" IS NOT NULL
  AND "role_id" IS NOT NULL
  AND "source" = 'role';

DELETE FROM "tool_grants"
WHERE "agent_id" IS NULL
  AND "role_id" IS NULL;

-- Retain the safest direct decision before making it unique: an explicit
-- denied tombstone wins, then a descriptor-fingerprinted allow, then the most
-- recently updated remaining legacy row. The same denied-then-newest rule
-- keeps duplicate role policy deterministic.
WITH ranked_direct_grants AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tool_id", "agent_id"
      ORDER BY
        CASE
          WHEN "state" = 'denied' THEN 0
          WHEN "state" = 'allowed' AND "config" ? 'descriptorFingerprint' THEN 1
          WHEN "state" = 'allowed' THEN 2
          ELSE 3
        END,
        "updated_at" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS row_number
  FROM "tool_grants"
  WHERE "agent_id" IS NOT NULL AND "role_id" IS NULL
)
DELETE FROM "tool_grants" AS duplicate
USING ranked_direct_grants
WHERE duplicate."id" = ranked_direct_grants."id"
  AND ranked_direct_grants.row_number > 1;

WITH ranked_role_grants AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tool_id", "role_id"
      ORDER BY
        CASE WHEN "state" = 'denied' THEN 0 ELSE 1 END,
        "updated_at" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS row_number
  FROM "tool_grants"
  WHERE "role_id" IS NOT NULL AND "agent_id" IS NULL
)
DELETE FROM "tool_grants" AS duplicate
USING ranked_role_grants
WHERE duplicate."id" = ranked_role_grants."id"
  AND ranked_role_grants.row_number > 1;

-- A ToolGrant is either a role policy or an exact-agent policy. It is never
-- both and never neither. The partial unique indexes make the per-agent lock
-- backed update-then-create paths durable across every writer.
ALTER TABLE "tool_grants"
  ADD CONSTRAINT "tool_grants_exactly_one_principal_check"
  CHECK (
    ("role_id" IS NOT NULL AND "agent_id" IS NULL)
    OR ("role_id" IS NULL AND "agent_id" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "tool_grants"
  VALIDATE CONSTRAINT "tool_grants_exactly_one_principal_check";

CREATE UNIQUE INDEX "tool_grants_role_principal_unique"
  ON "tool_grants" ("tool_id", "role_id")
  WHERE "role_id" IS NOT NULL AND "agent_id" IS NULL;

CREATE UNIQUE INDEX "tool_grants_agent_principal_unique"
  ON "tool_grants" ("tool_id", "agent_id")
  WHERE "agent_id" IS NOT NULL AND "role_id" IS NULL;
