-- One telling of one change, claimed so it happens once.
--
-- The notify step runs after the apply transaction commits, so a sync sweep and
-- a webhook that both apply the same item would both go on to tell the same
-- people. The fingerprint is the one applyInboundItem already computes, so the
-- claim is over exactly what changed rather than over the task.
CREATE TABLE "board_watch_notifications" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_watch_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "board_watch_notifications_task_id_fingerprint_key"
    ON "board_watch_notifications"("task_id", "fingerprint");
-- Swept by age, so the claim table does not grow without bound.
CREATE INDEX "board_watch_notifications_created_at_idx"
    ON "board_watch_notifications"("created_at");

ALTER TABLE "board_watch_notifications" ADD CONSTRAINT "board_watch_notifications_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
