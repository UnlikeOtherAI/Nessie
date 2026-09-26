CREATE TABLE "agent_conversation_suggestions" (
  "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "agent_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "attempted_at" TIMESTAMP(3),
  "generated_at" TIMESTAMP(3),
  "activity_hash" TEXT,
  "questions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sources" JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY ("organization_id", "user_id", "agent_id")
);
