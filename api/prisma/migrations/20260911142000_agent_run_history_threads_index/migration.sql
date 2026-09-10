-- Agent history enumerates the conversations an agent actually ran in before
-- performing an indexed top-k message seek for each one.
CREATE INDEX CONCURRENTLY "runs_agent_id_thread_id_history_idx"
  ON "runs" ("agent_id", "thread_id");
