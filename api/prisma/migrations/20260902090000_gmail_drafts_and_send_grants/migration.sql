-- Gmail draft actions + standing send consent.
--
-- The draft projection exists so an approval can bind to a draft's CONTENT
-- rather than its id: a Gmail draft stays mutable through the chat card, Gmail
-- itself, and other runs, so an id-scoped approval would authorise delivering
-- something nobody approved. It is also where the conditional
-- draft -> sending -> sent claim lives, making double-send impossible.

CREATE TYPE "GmailDraftActionState" AS ENUM ('draft', 'sending', 'sent', 'discarded');

CREATE TABLE "gmail_draft_actions" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"     UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "owner_user_id"       UUID NOT NULL,
  "connection_id"       UUID NOT NULL REFERENCES "comms_connections"("id") ON DELETE CASCADE,
  "provider_draft_id"   TEXT NOT NULL,
  "provider_thread_id"  TEXT,
  "content_fingerprint" TEXT NOT NULL,
  "revision"            INTEGER NOT NULL DEFAULT 1,
  "state"               "GmailDraftActionState" NOT NULL DEFAULT 'draft',
  "message_id"          UUID,
  "send_after"          TIMESTAMP(3),
  "sent_at"             TIMESTAMP(3),
  "sent_message_id"     TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "gmail_draft_actions_connection_draft_key"
  ON "gmail_draft_actions" ("connection_id", "provider_draft_id");
CREATE INDEX "gmail_draft_actions_owner_state_idx"
  ON "gmail_draft_actions" ("organization_id", "owner_user_id", "state");
-- Drives the undo-window sweep.
CREATE INDEX "gmail_draft_actions_send_after_idx"
  ON "gmail_draft_actions" ("state", "send_after");

-- Standing consent: one mailbox, one agent, exact-key lookup only. No wildcard,
-- no inheritance, no fallback — the ScopeDisclosureGrant shape.
CREATE TABLE "send_authorization_grants" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id"    UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "connection_id"      UUID NOT NULL REFERENCES "comms_connections"("id") ON DELETE CASCADE,
  "agent_id"           UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "granted_by_user_id" UUID NOT NULL,
  "expires_at"         TIMESTAMP(3),
  "revoked_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "send_authorization_grants_connection_agent_key"
  ON "send_authorization_grants" ("connection_id", "agent_id");
CREATE INDEX "send_authorization_grants_org_connection_idx"
  ON "send_authorization_grants" ("organization_id", "connection_id");

-- Only the mailbox owner may approve a send as themselves. Approval visibility
-- otherwise reaches any member who can read a public channel, which would let a
-- colleague authorise an email sent in your name.
ALTER TABLE "approval_requests"
  ADD COLUMN "required_approver_user_id" UUID;
