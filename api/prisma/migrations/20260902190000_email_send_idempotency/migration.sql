-- Outbound idempotency, and the state a crashed send lands in.
--
-- The dispatch claim (`queued` -> `sending`) makes it impossible to send one
-- ROW twice. It says nothing about creating two rows: a replayed run re-issues
-- the same `email_send` tool call, and each call was inserting a fresh row with
-- its own Message-ID, so both claimed cleanly and both reached SES. A duplicate
-- in somebody's inbox cannot be taken back, so the write is keyed on the tool
-- call's own identity — the same identity the approval machinery already uses.
ALTER TABLE "email_messages" ADD COLUMN "send_key" TEXT;
CREATE UNIQUE INDEX "email_messages_send_key_key" ON "email_messages"("send_key");
