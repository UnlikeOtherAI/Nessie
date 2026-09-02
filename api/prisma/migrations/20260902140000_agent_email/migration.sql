-- Hosted agent mailboxes (Model B) + the approval field the send gate needs.
-- Design: docs/plans/2026-09-02-agent-email.md
--
-- Amazon SES is integrated directly: the deployment's own account sends and
-- receives, so an address is unique per deployment and no intermediary service
-- exists. Emails are their own store rather than Message rows — delivery state,
-- MIME identity and external participants are not a chat thread's semantics.
-- Each mailbox keeps one backing channel (system_channel_type 'agent_email')
-- with one thread per conversation, which is where runs, approval gates and the
-- human conversation about the correspondence live.

-- Enum extensions. Deliberately first and unused by the DDL below: PostgreSQL
-- forbids a new enum value being *used* in the transaction that adds it, and
-- Prisma runs one migration file in a single transaction.
ALTER TYPE "ChannelSystemType" ADD VALUE IF NOT EXISTS 'agent_email';
ALTER TYPE "ConnectorType" ADD VALUE IF NOT EXISTS 'email';

CREATE TYPE "AgentMailboxStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "AgentMailboxSendPolicy" AS ENUM ('approval', 'auto_reply', 'auto');
CREATE TYPE "EmailMessageDirection" AS ENUM ('inbound', 'outbound');
CREATE TYPE "EmailMessageClassification" AS ENUM ('normal', 'bulk', 'dsn');
CREATE TYPE "EmailDeliveryState" AS ENUM ('queued', 'sending', 'sent', 'delivery_unknown', 'bounced', 'complained');
CREATE TYPE "EmailDomainStatus" AS ENUM ('pending_dns', 'verified', 'failed', 'revoked');

-- Pins an approval to one exact person. A send that acts as somebody's mailbox
-- is theirs to authorize; any org owner approving any agent's mail is the wrong
-- grain. Nullable, so every existing role-gated approval is unchanged.
ALTER TABLE "approval_requests" ADD COLUMN "required_approver_user_id" UUID;

-- Inbound MIME parts hang off the email message, never off the compact chat
-- reference message: chat visibility must not become an attachment's authority.
-- App-enforced link with no FK, mirroring "knowledge_page_id".
ALTER TABLE "attachments" ADD COLUMN "email_message_id" UUID;
CREATE INDEX "attachments_email_message_id_idx" ON "attachments"("email_message_id");

CREATE TABLE "email_domains" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "EmailDomainStatus" NOT NULL DEFAULT 'pending_dns',
    "status_reason" TEXT,
    "ses_identity_arn" TEXT,
    "dkim_tokens" JSONB NOT NULL DEFAULT '[]',
    "verified_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_domains_domain_key" ON "email_domains"("domain");
CREATE INDEX "email_domains_organization_id_status_idx" ON "email_domains"("organization_id", "status");

CREATE TABLE "agent_mailboxes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "domain_id" UUID,
    "channel_id" UUID NOT NULL,
    "status" "AgentMailboxStatus" NOT NULL DEFAULT 'active',
    "status_reason" TEXT,
    "retired_at" TIMESTAMP(3),
    "send_policy" "AgentMailboxSendPolicy" NOT NULL DEFAULT 'approval',
    "display_name" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_mailboxes_pkey" PRIMARY KEY ("id")
);

-- One mailbox per agent, and an address is claimed once per deployment. A
-- deleted mailbox keeps its row (retired_at set), so the unique index also
-- keeps a retired local part off the market — a recycled address must never
-- inherit an old correspondent's trust.
CREATE UNIQUE INDEX "agent_mailboxes_agent_id_key" ON "agent_mailboxes"("agent_id");
CREATE UNIQUE INDEX "agent_mailboxes_address_key" ON "agent_mailboxes"("address");
CREATE UNIQUE INDEX "agent_mailboxes_channel_id_key" ON "agent_mailboxes"("channel_id");
CREATE INDEX "agent_mailboxes_organization_id_status_idx" ON "agent_mailboxes"("organization_id", "status");

CREATE TABLE "email_conversations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "thread_id" UUID NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_conversations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_conversations_thread_id_key" ON "email_conversations"("thread_id");
CREATE INDEX "email_conversations_mailbox_id_last_message_at_idx" ON "email_conversations"("mailbox_id", "last_message_at");

CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mailbox_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "direction" "EmailMessageDirection" NOT NULL,
    "receipt_id" TEXT,
    "s3_object_key" TEXT,
    "rfc_message_id" TEXT NOT NULL,
    "in_reply_to" TEXT,
    "references_ids" JSONB NOT NULL DEFAULT '[]',
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "reply_to_address" TEXT,
    "to_addresses" JSONB NOT NULL DEFAULT '[]',
    "cc_addresses" JSONB NOT NULL DEFAULT '[]',
    "bcc_addresses" JSONB NOT NULL DEFAULT '[]',
    "envelope_recipients" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL,
    "text_body" TEXT NOT NULL,
    "html_body" TEXT,
    "snippet" TEXT NOT NULL,
    "auth_results" JSONB,
    "classification" "EmailMessageClassification" NOT NULL DEFAULT 'normal',
    "delivery_state" "EmailDeliveryState",
    "ses_message_id" TEXT,
    "sent_by_run_id" UUID,
    "approval_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- The inbound idempotency key. SES and SNS legitimately retry, so the
-- claim-and-wake transaction turns on the receipt id — never on the RFC
-- Message-ID, which can be absent, duplicated or attacker-forged.
CREATE UNIQUE INDEX "email_messages_receipt_id_key" ON "email_messages"("receipt_id");
CREATE INDEX "email_messages_conversation_id_occurred_at_idx" ON "email_messages"("conversation_id", "occurred_at");
-- Threading lookup only. Deliberately NOT unique: a forged or duplicated
-- Message-ID must degrade to a new conversation, not drop or mis-merge a message.
CREATE INDEX "email_messages_mailbox_id_rfc_message_id_idx" ON "email_messages"("mailbox_id", "rfc_message_id");
CREATE INDEX "email_messages_mailbox_id_delivery_state_idx" ON "email_messages"("mailbox_id", "delivery_state");

-- Reputation is per SES account, so suppression is deliberately org-agnostic:
-- a recipient that hard-bounced for one organisation must not be re-mailed by
-- another on the same deployment.
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_suppressions_address_key" ON "email_suppressions"("address");

ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "email_domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- RESTRICT, not CASCADE: the backing channel is created with the mailbox and is
-- not independently disposable — dropping it would take the correspondence with
-- it. Mailbox deletion removes the pair in order.
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "agent_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_conversations" ADD CONSTRAINT "email_conversations_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "agent_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "email_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
