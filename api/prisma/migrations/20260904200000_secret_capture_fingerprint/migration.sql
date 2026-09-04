-- A server-keyed HMAC lets idempotent capture reject a changed secret value
-- without storing plaintext or an offline-guessable unkeyed digest.
ALTER TABLE "secrets" ADD COLUMN "capture_fingerprint" TEXT;
