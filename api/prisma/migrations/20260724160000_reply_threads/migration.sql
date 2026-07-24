-- Message-level reply threads (issue #233): a nullable self-FK anchors a reply
-- to its root message (one level deep — replies to replies attach to the same
-- root), materialized per-root reply metadata keeps collapsed-bar rendering
-- cheap, and message_thread_follows tracks per-user follows (auto-follow on
-- participate + explicit unfollow) as the substrate for reply unread/inbox.

ALTER TABLE "messages"
  ADD COLUMN "root_message_id" UUID,
  ADD COLUMN "reply_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_reply_at" TIMESTAMP(3),
  ADD COLUMN "reply_participant_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_root_message_id_fkey"
    FOREIGN KEY ("root_message_id") REFERENCES "messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "messages_root_message_id_created_at_idx"
  ON "messages"("root_message_id", "created_at");

CREATE TABLE "message_thread_follows" (
  "id" UUID NOT NULL,
  "root_message_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "message_thread_follows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_thread_follows_root_message_id_fkey"
    FOREIGN KEY ("root_message_id") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_thread_follows_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "message_thread_follows_root_message_id_user_id_key"
  ON "message_thread_follows"("root_message_id", "user_id");

CREATE INDEX "message_thread_follows_user_id_idx"
  ON "message_thread_follows"("user_id");
