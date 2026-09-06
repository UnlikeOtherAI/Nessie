-- A board's own glyph in the Projects sidebar: one emoji, or NULL for the
-- shared board icon every board has worn until now.
--
-- Nullable with no default, so every existing board keeps that shared icon and
-- no backfill is needed. Not an attachment: a board is a saved way of looking
-- at a project's work, and a picture upload would be a heavier promise than
-- the row it decorates.
ALTER TABLE "boards"
  ADD COLUMN "icon_emoji" TEXT;
