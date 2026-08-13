CREATE TABLE "message_conversation_read_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "root_message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "last_read_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "message_conversation_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_conversation_read_states_root_message_id_user_id_key"
  ON "message_conversation_read_states"("root_message_id", "user_id");

CREATE INDEX "message_conversation_read_states_user_id_idx"
  ON "message_conversation_read_states"("user_id");

ALTER TABLE "message_conversation_read_states"
  ADD CONSTRAINT "message_conversation_read_states_root_message_id_fkey"
  FOREIGN KEY ("root_message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_conversation_read_states"
  ADD CONSTRAINT "message_conversation_read_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
