-- Keep the caller-request fingerprint separate from the provider-read proof.
-- Provider attachment identities are not available in the original upload,
-- but an idempotency key must still reject a replay with different input.
ALTER TABLE "gmail_draft_actions"
  ADD COLUMN "client_content_fingerprint" TEXT;

UPDATE "gmail_draft_actions"
  SET "client_content_fingerprint" = "content_fingerprint";

ALTER TABLE "gmail_draft_actions"
  ALTER COLUMN "client_content_fingerprint" SET NOT NULL;
