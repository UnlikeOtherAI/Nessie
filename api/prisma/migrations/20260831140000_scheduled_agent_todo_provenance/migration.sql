-- A pended scheduled to-do carries its template through the existing
-- per-thread serialization queue. The adopting run, not each fire, creates
-- the checklist instance.
ALTER TABLE "run_thread_pending_messages"
  ADD COLUMN "todo_template_id" UUID;

CREATE INDEX "run_thread_pending_messages_todo_template_id_idx"
  ON "run_thread_pending_messages"("todo_template_id");
