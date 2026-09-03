-- Additive only, safe under migrate-then-restart: a nullable column with no
-- backfill and a new enum value. Old code never reads `claimed_at` and never
-- writes `dispatching`; new code treats a missing claim as unclaimed.
ALTER TABLE "gmail_draft_actions" ADD COLUMN "claimed_at" TIMESTAMP(3);

ALTER TYPE "GmailDraftActionState" ADD VALUE 'dispatching';
