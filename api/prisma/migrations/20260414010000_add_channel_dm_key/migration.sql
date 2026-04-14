-- AlterTable
ALTER TABLE "channels" ADD COLUMN "dm_key" TEXT;

-- Backfill dm_key for existing DM channels using deterministic key:
-- organization_id:team_id:sorted_member_ids
-- Only backfills the EARLIEST channel per (org, team, member-set) to avoid
-- unique-index failures on databases that already have duplicate DM rows.
UPDATE "channels" c
SET "dm_key" = (
  SELECT
    c2."organization_id"::text || ':' || c2."team_id"::text || ':' ||
    (
      SELECT string_agg(cm."user_id"::text, ':' ORDER BY cm."user_id")
      FROM "channel_members" cm
      WHERE cm."channel_id" = c2.id
    )
  FROM "channels" c2
  WHERE c2.id = c.id
)
WHERE c."type" = 'dm'
  AND c.id = (
    -- Among all DM channels with the same member set, pick the earliest
    SELECT c3.id
    FROM "channels" c3
    WHERE c3."type" = 'dm'
      AND c3."organization_id" = c."organization_id"
      AND c3."team_id" = c."team_id"
      AND (
        SELECT string_agg(cm2."user_id"::text, ':' ORDER BY cm2."user_id")
        FROM "channel_members" cm2
        WHERE cm2."channel_id" = c3.id
      ) = (
        SELECT string_agg(cm3."user_id"::text, ':' ORDER BY cm3."user_id")
        FROM "channel_members" cm3
        WHERE cm3."channel_id" = c.id
      )
    ORDER BY c3."created_at" ASC
    LIMIT 1
  );

-- CreateIndex (after backfill — duplicate legacy rows keep dm_key NULL,
-- which does not violate the unique constraint in PostgreSQL)
CREATE UNIQUE INDEX "channels_dm_key_key" ON "channels"("dm_key");
