-- An archived channel stops holding its name.
--
-- `DELETE /api/channels/:id` archives rather than hard-deletes, and every list
-- a person can see hides archived channels. So a deleted `#random` left no
-- trace except the refusal to create a new one — a conflict with a channel
-- nobody could see, open, or rename. The name is released instead, and
-- unarchiving re-checks it (see `setChannelArchived`).
--
-- The index keeps its name so `throwIfChannelSlugConflict` still recognises the
-- constraint target. Rebuilding it is a widening, so no existing row can
-- violate the new condition.
DROP INDEX IF EXISTS "channels_project_slug_standard_key";

CREATE UNIQUE INDEX IF NOT EXISTS "channels_project_slug_standard_key"
  ON "channels"("project_id", "slug")
  WHERE "type" = 'standard' AND "archived_at" IS NULL;
