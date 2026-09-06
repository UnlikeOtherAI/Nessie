-- Tool-effect ledger (horizontal scaling, phase 3.2).
--
-- The crash checkpoint records a tool's result AFTER the tool returns, which
-- leaves one window it cannot close: a worker that dies between a side effect
-- committing at the provider and its record committing in Postgres leaves no
-- trace of a call that really happened, and the resumed run runs it again — a
-- second mail, a second ticket, a second calendar entry.
--
-- One row is written and committed here BEFORE any side-effecting tool is
-- dispatched, so a resume can tell "this may already have happened"
-- (state = 'dispatched') from "this never started" (no row) and from "this is
-- done, here is what it returned" (state = 'completed', with `result`).
--
-- The unique key is (run_id, tool_call_id): the provider's tool-call id is
-- unique within a run and is the same key the crash checkpoint's recorded
-- results are keyed by, so the two agree about what "this call" means.
--
-- Rows are per tool call and are shed by `updateRunStatus` on every terminal
-- and suspended transition; the cascade below is the backstop for a run that is
-- deleted outright.
CREATE TABLE "run_tool_effects" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "tool_call_id" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "result" JSONB,
  "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),

  CONSTRAINT "run_tool_effects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_tool_effects_run_id_tool_call_id_key"
  ON "run_tool_effects"("run_id", "tool_call_id");

ALTER TABLE "run_tool_effects"
  ADD CONSTRAINT "run_tool_effects_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
