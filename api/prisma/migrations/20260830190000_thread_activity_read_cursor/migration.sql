ALTER TABLE "message_conversation_read_states"
  ADD COLUMN "last_read_message_id" UUID;

CREATE INDEX "idx_message_conversation_read_states_user_cursor"
  ON "message_conversation_read_states" ("user_id", "last_read_at", "last_read_message_id");
