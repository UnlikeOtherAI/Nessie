-- Who to tell when a ticket on a board changes.
--
-- A board is a view over the project's task pool, so a watcher is a statement
-- about a slice of that pool rather than about any task. Exactly one of
-- user_id / agent_id is set, enforced below: a row that named both would be two
-- recipients wearing one unique key, and a row that named neither would be a
-- notification with nowhere to go.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'board_ticket_changed';

CREATE TABLE "board_watchers" (
    "id" UUID NOT NULL,
    "board_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_watchers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "board_watchers_one_recipient" CHECK (
        ("user_id" IS NOT NULL AND "agent_id" IS NULL)
     OR ("user_id" IS NULL AND "agent_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "board_watchers_board_id_user_id_key"
    ON "board_watchers"("board_id", "user_id");
CREATE UNIQUE INDEX "board_watchers_board_id_agent_id_key"
    ON "board_watchers"("board_id", "agent_id");
CREATE INDEX "board_watchers_organization_id_idx"
    ON "board_watchers"("organization_id");

ALTER TABLE "board_watchers" ADD CONSTRAINT "board_watchers_board_id_fkey"
    FOREIGN KEY ("board_id") REFERENCES "boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A watcher who leaves, or an agent that is deleted, stops being a watcher.
-- Rows that outlive their subject would write alerts into the void.
ALTER TABLE "board_watchers" ADD CONSTRAINT "board_watchers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_watchers" ADD CONSTRAINT "board_watchers_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
