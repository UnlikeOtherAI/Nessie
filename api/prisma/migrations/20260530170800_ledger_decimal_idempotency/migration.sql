-- Money/cost hardening for the ledger subsystem.
--
-- (J) Convert DOUBLE PRECISION cost columns to NUMERIC so token-cost math is
--     exact rather than binary-float-lossy.
-- (K) Make execution_usage_ledger.recorded_at timezone-aware, consistent with
--     the rest of the ledger (token_ledger_events.occurred_at, etc.).
-- (M) Add a per-inference idempotency key + unique constraint to
--     token_ledger_events so a crash-then-redeliver of persistInvocationLedgerEvents
--     cannot double-count cost.
-- (N) Convert execution_usage_ledger.actor_type from free-text to the
--     AuditActorType enum (its only writer already supplies 'agent'|'service'|
--     'user', all in the enum vocabulary).
--
-- VALUE GUARD (N): before applying, confirm every existing value is in the enum:
--   SELECT DISTINCT actor_type FROM execution_usage_ledger
--   WHERE actor_type NOT IN ('user','agent','service','system');
-- Must return zero rows; otherwise map the stray values first.

-- ── (J) token_ledger_events cost columns -> NUMERIC(20,8) ────────────────────
ALTER TABLE "token_ledger_events"
  ALTER COLUMN "provider_cost_amount" TYPE DECIMAL(20, 8) USING "provider_cost_amount"::numeric;
ALTER TABLE "token_ledger_events"
  ALTER COLUMN "pricing_input_per_m" TYPE DECIMAL(20, 8) USING "pricing_input_per_m"::numeric;
ALTER TABLE "token_ledger_events"
  ALTER COLUMN "pricing_output_per_m" TYPE DECIMAL(20, 8) USING "pricing_output_per_m"::numeric;
ALTER TABLE "token_ledger_events"
  ALTER COLUMN "estimated_cost_amount" TYPE DECIMAL(20, 8) USING "estimated_cost_amount"::numeric;

-- ── (M) token_ledger_events idempotency key ─────────────────────────────────
ALTER TABLE "token_ledger_events"
  ADD COLUMN "inference_invocation_id" TEXT;
CREATE UNIQUE INDEX "token_ledger_events_inference_invocation_id_key"
  ON "token_ledger_events" ("inference_invocation_id");

-- ── (J) model_pricing_profiles per-million rates -> NUMERIC(20,8) ────────────
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "input_per_million" TYPE DECIMAL(20, 8) USING "input_per_million"::numeric;
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "output_per_million" TYPE DECIMAL(20, 8) USING "output_per_million"::numeric;
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "cached_input_per_million" TYPE DECIMAL(20, 8) USING "cached_input_per_million"::numeric;
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "cached_output_per_million" TYPE DECIMAL(20, 8) USING "cached_output_per_million"::numeric;
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "cache_read_per_million" TYPE DECIMAL(20, 8) USING "cache_read_per_million"::numeric;
ALTER TABLE "model_pricing_profiles"
  ALTER COLUMN "cache_write_per_million" TYPE DECIMAL(20, 8) USING "cache_write_per_million"::numeric;

-- (budgets.cost_limit_usd is created as DECIMAL(14,4) directly by its own
-- migration 20260530180000_budgets_scoped, which runs after this one — so it is
-- intentionally not converted here.)

-- ── (J/K/N) execution_usage_ledger ───────────────────────────────────────────
ALTER TABLE "execution_usage_ledger"
  ALTER COLUMN "quantity" TYPE DECIMAL(20, 8) USING "quantity"::numeric;
ALTER TABLE "execution_usage_ledger"
  ALTER COLUMN "unit_price" TYPE DECIMAL(20, 8) USING "unit_price"::numeric;
ALTER TABLE "execution_usage_ledger"
  ALTER COLUMN "cost_amount" TYPE DECIMAL(14, 4) USING "cost_amount"::numeric;
ALTER TABLE "execution_usage_ledger"
  ALTER COLUMN "recorded_at" TYPE TIMESTAMPTZ(6) USING "recorded_at" AT TIME ZONE 'UTC';
ALTER TABLE "execution_usage_ledger"
  ALTER COLUMN "actor_type" TYPE "AuditActorType" USING "actor_type"::"AuditActorType";
