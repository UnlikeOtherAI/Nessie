-- Agent conversations: a Thread becomes the conversation container an agent is
-- addressed in. `agent_id` NULL keeps meaning the channel's own General thread,
-- so no backfill is possible or wanted — every existing row is already General.
--
-- Both foreign keys are ON DELETE SET NULL, never CASCADE: removing an agent or
-- a person must not delete the record of what was said.
ALTER TABLE "threads"
  ADD COLUMN "agent_id" UUID,
  ADD COLUMN "started_by_user_id" UUID;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_started_by_user_id_fkey"
  FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial: an agent's conversation list never reads a General row through this
-- index, and General is nearly every row in an existing install.
CREATE INDEX "threads_agent_updated_idx"
  ON "threads" ("agent_id", "updated_at" DESC)
  WHERE "agent_id" IS NOT NULL;

-- "the General thread of this channel" and "this agent's conversations in this
-- channel" are both this index.
CREATE INDEX "threads_channel_agent_idx" ON "threads" ("channel_id", "agent_id");
