-- An organisation's own colour scheme: the four authored seeds, never the
-- derived tokens. Beside logo_attachment_id and strip_image_metadata because it
-- is the same kind of thing — content the organisation owns, that every member
-- reads and only an administrator writes.
ALTER TABLE "organizations" ADD COLUMN "theme" jsonb;

-- Make "never chose a theme" true again.
--
-- ThemeProvider used to mirror its own default into localStorage on every
-- mount and copy that onto the account at first sign-in, so 'sandstone' in
-- preferences means "chose Sandstone" and "never opened the picker" alike.
-- Left as it is, an organisation theme would reach new accounts only, and the
-- administrator who saved it would see nothing change on their own screen.
-- Dropping the key is safe because Sandstone remains the fallback: nobody's
-- screen changes today, and anyone who did mean it can re-choose in one click.
UPDATE "users"
   SET "preferences" = "preferences" - 'theme'
 WHERE "preferences" ->> 'theme' = 'sandstone';
