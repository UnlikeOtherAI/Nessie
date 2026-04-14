-- AlterTable
ALTER TABLE "channels" ADD COLUMN "dm_key" TEXT;

-- Backfill dm_key for existing DM channels using deterministic key:
-- organization_id:team_id:sorted_member_ids
UPDATE "channels" c
SET "dm_key" = (
  SELECT
    c2."organization_id" || ':' || c2."team_id" || ':' ||
    (
      SELECT string_agg(cm."user_id"::text, ':' ORDER BY cm."user_id")
      FROM "channel_members" cm
      WHERE cm."channel_id" = c2.id
    )
  FROM "channels" c2
  WHERE c2.id = c.id
)
WHERE c."type" = 'dm';

-- CreateIndex (after backfill so existing rows don't violate uniqueness)
CREATE UNIQUE INDEX "channels_dm_key_key" ON "channels"("dm_key");
