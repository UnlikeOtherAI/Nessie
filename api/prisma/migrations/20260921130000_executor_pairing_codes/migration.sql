ALTER TABLE "executors" ADD COLUMN "pairing_team_id" TEXT;
CREATE TABLE "executor_pairing_codes" (
  "id" UUID NOT NULL PRIMARY KEY,
  "code_verifier" TEXT NOT NULL UNIQUE,
  "code_nonce" INTEGER NOT NULL DEFAULT 0,
  "request_digest" TEXT NOT NULL,
  "machine_public_key" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "machine_name" TEXT NOT NULL,
  "descriptor" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "claimed_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "claim_digest" TEXT,
  "executor_id" UUID REFERENCES "executors"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "executor_pairing_codes_expires_at_idx" ON "executor_pairing_codes"("expires_at");
CREATE INDEX "executor_pairing_codes_fingerprint_idx" ON "executor_pairing_codes"("fingerprint");
