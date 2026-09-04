-- A generic mailbox whose password was rejected is a stopped capability, not
-- merely a transient test error. Its revision identifies one health
-- transition, and the alert relation lets the bell revalidate the connection
-- after an explicit reconnect.
ALTER TABLE "mailbox_connections"
  ADD COLUMN "health_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'mailbox_connection_health';

ALTER TABLE "user_alerts"
  ADD COLUMN "mailbox_connection_id" UUID;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_mailbox_connection_id_fkey"
  FOREIGN KEY ("mailbox_connection_id") REFERENCES "mailbox_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_alerts_mailbox_connection_id_idx"
  ON "user_alerts"("mailbox_connection_id");
