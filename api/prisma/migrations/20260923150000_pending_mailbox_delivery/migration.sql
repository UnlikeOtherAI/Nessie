-- A mailbox delivery that pends behind a busy agent keeps its link to the
-- mailbox row, so the drain can give the follow-up run the plan or workflow
-- step the mail was sent for, exactly as a direct mailbox claim does.
ALTER TABLE "run_thread_pending_messages" ADD COLUMN "mailbox_message_id" UUID;

ALTER TABLE "run_thread_pending_messages"
  ADD CONSTRAINT "run_thread_pending_messages_mailbox_message_id_fkey"
  FOREIGN KEY ("mailbox_message_id") REFERENCES "agent_mailbox_messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
