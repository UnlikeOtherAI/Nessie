-- A system-authored review card for a prepared executor access change stores
-- only the change's id. The confirmation token is minted for the person who
-- presses the card and is never stored here, in the message, or in anything a
-- model reads.
ALTER TABLE "agent_cards" ADD COLUMN "executor_access_change_id" UUID;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_executor_access_change_id_fkey"
  FOREIGN KEY ("executor_access_change_id") REFERENCES "executor_continuations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "agent_cards_executor_access_change_id_idx" ON "agent_cards"("executor_access_change_id");
