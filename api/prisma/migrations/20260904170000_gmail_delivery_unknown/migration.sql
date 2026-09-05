-- A create is persisted before Gmail is called. NULL provider ids represent
-- only an externally ambiguous create and must never be retried automatically.
ALTER TABLE "gmail_draft_actions" ALTER COLUMN "provider_draft_id" DROP NOT NULL;
ALTER TABLE "gmail_draft_actions" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "gmail_draft_actions_connection_id_client_request_id_key"
  ON "gmail_draft_actions"("connection_id", "client_request_id");

ALTER TYPE "GmailDraftActionState" ADD VALUE 'creating';
ALTER TYPE "GmailDraftActionState" ADD VALUE 'delivery_unknown';
