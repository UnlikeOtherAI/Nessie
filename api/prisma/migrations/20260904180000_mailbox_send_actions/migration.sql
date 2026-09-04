CREATE TYPE "MailboxSendActionState" AS ENUM ('ready', 'dispatching', 'sent', 'delivery_unknown');

CREATE TABLE "mailbox_send_actions" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "client_request_id" UUID NOT NULL,
  "content_fingerprint" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "state" "MailboxSendActionState" NOT NULL DEFAULT 'ready',
  "claimed_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mailbox_send_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailbox_send_actions_connection_id_client_request_id_key"
  ON "mailbox_send_actions"("connection_id", "client_request_id");
CREATE UNIQUE INDEX "mailbox_send_actions_connection_id_message_id_key"
  ON "mailbox_send_actions"("connection_id", "message_id");
CREATE INDEX "mailbox_send_actions_organization_id_owner_user_id_state_idx"
  ON "mailbox_send_actions"("organization_id", "owner_user_id", "state");
ALTER TABLE "mailbox_send_actions" ADD CONSTRAINT "mailbox_send_actions_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mailbox_send_actions" ADD CONSTRAINT "mailbox_send_actions_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "mailbox_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
