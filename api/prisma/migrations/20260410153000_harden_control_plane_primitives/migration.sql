ALTER TABLE "tool_registry_entries"
ADD COLUMN "scope_key" TEXT;

UPDATE "tool_registry_entries"
SET "scope_key" = CASE
  WHEN "builtin" THEN 'builtin'
  WHEN "organization_id" IS NOT NULL THEN "organization_id"::text
  ELSE 'builtin'
END
WHERE "scope_key" IS NULL;

ALTER TABLE "tool_registry_entries"
ALTER COLUMN "scope_key" SET NOT NULL;

ALTER TABLE "tool_registry_entries"
DROP CONSTRAINT IF EXISTS "tool_registry_entries_tool_id_key";

CREATE UNIQUE INDEX "tool_registry_entries_scope_key_tool_id_key"
ON "tool_registry_entries"("scope_key", "tool_id");

CREATE UNIQUE INDEX "plan_steps_plan_id_sequence_key"
ON "plan_steps"("plan_id", "sequence");
