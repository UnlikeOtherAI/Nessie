-- How a board-source connection's credential was obtained.
--
-- Existing rows are all OAuth grants: the API-key path did not exist when they
-- were written, so the default backfills them correctly and no data migration
-- is needed.
CREATE TYPE "BoardSourceAuthMethod" AS ENUM ('oauth', 'api_key');

ALTER TABLE "board_source_connections"
  ADD COLUMN "auth_method" "BoardSourceAuthMethod" NOT NULL DEFAULT 'oauth';
