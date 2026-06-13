CREATE TABLE "refresh_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "provider_id" TEXT NOT NULL,
  "provider_type" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "replaced_by_id" UUID,
  "user_agent" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
