ALTER TABLE "product_account_links"
  ADD COLUMN "uoa_token_version" INTEGER;

ALTER TABLE "product_account_links"
  ADD CONSTRAINT "product_account_links_uoa_token_version_nonnegative"
  CHECK ("uoa_token_version" IS NULL OR "uoa_token_version" >= 0);

ALTER TABLE "refresh_tokens"
  ADD COLUMN "replay_protected_until" TIMESTAMPTZ(6);

-- Existing local UOA refresh families deliberately have no row here and must
-- reauthenticate. New families store their own encrypted upstream credential;
-- they never borrow proof or refresh state from ProductAccountLink.
CREATE TABLE "uoa_session_credentials" (
  "family_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "token_version" INTEGER NOT NULL,
  "config_url" TEXT NOT NULL,
  "refresh_token_hash" TEXT NOT NULL,
  "refresh_token_ciphertext" TEXT NOT NULL,
  "refresh_token_iv" TEXT NOT NULL,
  "refresh_token_auth_tag" TEXT NOT NULL,
  "refresh_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "last_local_token_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "uoa_session_credentials_pkey" PRIMARY KEY ("family_id"),
  CONSTRAINT "uoa_session_credentials_refresh_token_hash_key"
    UNIQUE ("refresh_token_hash"),
  CONSTRAINT "uoa_session_credentials_last_local_token_id_key"
    UNIQUE ("last_local_token_id"),
  CONSTRAINT "uoa_session_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "uoa_session_credentials_last_local_token_id_fkey"
    FOREIGN KEY ("last_local_token_id") REFERENCES "refresh_tokens"("id") ON DELETE CASCADE,
  CONSTRAINT "uoa_session_credentials_token_version_nonnegative"
    CHECK ("token_version" >= 0),
  CONSTRAINT "uoa_session_credentials_generation_nonnegative"
    CHECK ("generation" >= 0),
  CONSTRAINT "uoa_session_credentials_proof_nonempty"
    CHECK (
      LENGTH(BTRIM("provider_id")) > 0
      AND LENGTH(BTRIM("subject")) > 0
      AND LENGTH(BTRIM("organization_id")) > 0
      AND LENGTH(BTRIM("team_id")) > 0
      AND LENGTH(BTRIM("config_url")) > 0
      AND LENGTH(BTRIM("refresh_token_hash")) > 0
      AND LENGTH(BTRIM("refresh_token_ciphertext")) > 0
      AND LENGTH(BTRIM("refresh_token_iv")) > 0
      AND LENGTH(BTRIM("refresh_token_auth_tag")) > 0
    )
);

CREATE INDEX "uoa_session_credentials_user_id_idx"
  ON "uoa_session_credentials"("user_id");
