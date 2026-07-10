-- Space membership grants become principal-based: a row grants a user XOR an
-- agent. Existing rows keep their user_id; agent grants are new rows.
ALTER TABLE "knowledge_space_members" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "knowledge_space_members" ADD COLUMN "agent_id" UUID;

ALTER TABLE "knowledge_space_members"
  ADD CONSTRAINT "knowledge_space_members_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "knowledge_space_members_space_id_agent_id_key"
  ON "knowledge_space_members"("space_id", "agent_id");
CREATE INDEX "knowledge_space_members_agent_id_idx"
  ON "knowledge_space_members"("agent_id");
