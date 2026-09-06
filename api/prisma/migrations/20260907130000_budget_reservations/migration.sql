-- An admitted run's budget ceiling, held while its real spend is unrecorded.
--
-- The spend gate read `token_ledger_events`, which a run only writes when it
-- records usage, so every replica admitting at the same moment saw the same
-- pre-run total and `enforce`/`degrade` overshot by however many runs started
-- together. Admission now takes `pg_advisory_xact_lock` on the governing budget
-- scope and inserts a row here in the same transaction; the next admitter
-- counts these rows alongside recorded spend.
--
-- The row is deleted when the run records actual usage, cascades with the run,
-- and is ignored by the aggregate once the run is terminal — so a crashed run
-- cannot hold budget hostage even before the worker's sweep removes it.

CREATE TABLE "budget_reservations" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "scope_type" "BudgetScopeType" NOT NULL,
  "scope_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "reserved_cost_usd" DECIMAL(14, 4) NOT NULL DEFAULT 0,
  "reserved_tokens" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id")
);

-- One reservation per run: a redelivered run replaces its own row rather than
-- reserving a second time.
CREATE UNIQUE INDEX "budget_reservations_run_id_key"
  ON "budget_reservations" ("run_id");

-- The admission aggregate's access path: everything open for one budget scope
-- inside the current period.
CREATE INDEX "budget_reservations_scope_type_scope_id_created_at_idx"
  ON "budget_reservations" ("scope_type", "scope_id", "created_at");

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
