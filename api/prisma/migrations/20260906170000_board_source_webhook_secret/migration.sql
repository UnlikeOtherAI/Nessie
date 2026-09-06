-- A board source registers its own webhook with the provider rather than
-- depending on an app-level one the deployment may never have configured.
-- Linear mints the signing secret and hands it back exactly once, so it is
-- kept here, sealed with the same envelope credentials use.
ALTER TABLE "board_sources" ADD COLUMN "webhook_secret_ciphertext" TEXT;
