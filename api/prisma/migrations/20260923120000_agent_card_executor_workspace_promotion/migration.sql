-- A workspace promotion prepared from a conversation is reviewed through the
-- same system-authored card as an access change: the row stores only the
-- promotion's id, and the confirmation token is minted for the person who
-- presses it, never stored here, in the message, or in anything a model reads.
ALTER TABLE "agent_cards" ADD COLUMN "executor_workspace_promotion_id" UUID;
ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_executor_workspace_promotion_id_fkey"
  FOREIGN KEY ("executor_workspace_promotion_id") REFERENCES "executor_continuations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "agent_cards_executor_workspace_promotion_id_idx" ON "agent_cards"("executor_workspace_promotion_id");
