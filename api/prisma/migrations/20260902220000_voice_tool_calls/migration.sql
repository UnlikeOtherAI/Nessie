-- One tool call inside a voice conversation.
--
-- Gemini retries a tool call it did not see answered, so the provider's call
-- id is the claim and the argument hash sits beside it: an identical replay is
-- served from the stored result, while a replay carrying different arguments
-- is a different action wearing the same id and is refused.

CREATE TABLE "voice_tool_calls" (
    "id" UUID NOT NULL,
    "voice_session_id" UUID NOT NULL,
    "provider_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments_hash" TEXT NOT NULL,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_tool_calls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_tool_calls_voice_session_id_provider_call_id_key" ON "voice_tool_calls"("voice_session_id", "provider_call_id");
CREATE INDEX "voice_tool_calls_voice_session_id_idx" ON "voice_tool_calls"("voice_session_id");

ALTER TABLE "voice_tool_calls" ADD CONSTRAINT "voice_tool_calls_voice_session_id_fkey" FOREIGN KEY ("voice_session_id") REFERENCES "voice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
