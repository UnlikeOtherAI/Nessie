-- Project visibility, agent soft delete, and channel visibility backfill.
--
-- This migration is safe for a blue-green swap: it only adds nullable columns
-- and a new enum, sets defaults that match the previous behaviour, and backfills
-- existing rows. No column becomes more restrictive.

-- 1. Project visibility: a new enum and column.
CREATE TYPE "ProjectVisibility" AS ENUM ('public', 'protected');

ALTER TABLE "projects"
  ADD COLUMN "visibility" "ProjectVisibility" NOT NULL DEFAULT 'public';

-- Every existing project is public on deploy day. This is a deliberate
-- disclosure expansion documented in the visibility spec.
UPDATE "projects" SET "visibility" = 'public' WHERE "visibility" IS NULL;

-- 2. Agent soft delete. The row stays; live capabilities are revoked by the
--    delete route in the same transaction.
ALTER TABLE "agents"
  ADD COLUMN "deleted_at" TIMESTAMP(3);

-- 3. Agent mailbox soft delete. The address is held, not released for reuse.
ALTER TABLE "agent_mailboxes"
  ADD COLUMN "deleted_at" TIMESTAMP(3);

-- 4. Backfill private standard channels to protected.
--    DM and system-managed channels stay private; only user-created standard
--    channels are affected.
UPDATE "channels"
SET "visibility" = 'protected'
WHERE "visibility" = 'private'
  AND "type" = 'standard'
  AND "system_channel_type" IS NULL
  AND "dm_key" IS NULL;
