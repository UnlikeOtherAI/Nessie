-- Workflow-run alert visibility follows the installation's current channel,
-- so Prisma needs the same durable relationship the entitlement routes read.
-- Older installations predate this FK. A missing or cross-organization channel
-- is no longer a valid workflow scope, so detach it before enforcing the link.
UPDATE "workflow_installations" AS installation
SET "channel_id" = NULL
WHERE "channel_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "channels" AS channel
    WHERE channel."id" = installation."channel_id"
      AND channel."organization_id" = installation."organization_id"
  );

ALTER TABLE "workflow_installations"
  ADD CONSTRAINT "workflow_installations_channel_id_fkey"
  FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "workflow_installations_channel_id_idx"
  ON "workflow_installations"("channel_id");
