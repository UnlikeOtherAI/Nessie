-- Ring versions are opaque labels (for example `2026-09`), not counters.
-- Keep the existing column name because it is the operational progress mirror,
-- but move it to text before the rotation procedure starts writing labels.
ALTER TABLE "board_source_connection_credentials"
  ALTER COLUMN "key_version" TYPE TEXT USING "key_version"::TEXT,
  ALTER COLUMN "key_version" SET DEFAULT 'legacy';

UPDATE "board_source_connection_credentials"
SET "key_version" = 'legacy'
WHERE "key_version" = '1';

ALTER TABLE "comms_connection_credentials"
  ALTER COLUMN "key_version" TYPE TEXT USING "key_version"::TEXT,
  ALTER COLUMN "key_version" SET DEFAULT 'legacy';

UPDATE "comms_connection_credentials"
SET "key_version" = 'legacy'
WHERE "key_version" = '1';

ALTER TABLE "mailbox_connection_credentials"
  ALTER COLUMN "key_version" TYPE TEXT USING "key_version"::TEXT,
  ALTER COLUMN "key_version" SET DEFAULT 'legacy';

UPDATE "mailbox_connection_credentials"
SET "key_version" = 'legacy'
WHERE "key_version" = '1';
