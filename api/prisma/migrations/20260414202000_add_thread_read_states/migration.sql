CREATE TABLE "thread_read_states" (
  "id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "last_read_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "thread_read_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "thread_read_states_thread_id_user_id_key"
  ON "thread_read_states"("thread_id", "user_id");

CREATE INDEX "thread_read_states_user_id_idx"
  ON "thread_read_states"("user_id");

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_thread_id_fkey"
  FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "thread_read_states"
  ADD CONSTRAINT "thread_read_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
