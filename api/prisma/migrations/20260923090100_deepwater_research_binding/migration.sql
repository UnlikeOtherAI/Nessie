-- DeepWater research briefs: bind a product run to whoever asked for it, what
-- they were allowed to read, the brief being agreed with DeepWater's planner,
-- and the one-time delivery of the result.
--
-- Every column is additive with a default or NULL, so a replica still running
-- the previous build keeps inserting launcher rows unchanged: it writes none of
-- them, and the CHECKs below hold for a row that sets neither `uoa_identity`
-- nor `scope_json`.

ALTER TABLE "product_integration_runs"
  -- Who the result is addressed to.
  ADD COLUMN "origin_kind" TEXT NOT NULL DEFAULT 'person',
  ADD COLUMN "origin_agent_id" UUID,
  ADD COLUMN "origin_run_id" UUID,
  -- Agent origin: the provider tool-call id of research_scope_start.
  -- Person origin: the actionId of the request that opened the brief.
  ADD COLUMN "origin_tool_call_id" TEXT,
  -- The origin Run's principal, captured at claim: `origin_run_id` is SET NULL
  -- when that run is deleted, and a wake must not depend on it.
  ADD COLUMN "principal_user_id" UUID,
  -- The requester's UOA session identity {subject, organizationId, teamId,
  -- tokenVersion}: stable UOA ids only, never a profile field.
  ADD COLUMN "uoa_identity" JSONB,
  -- The consumed-source basis, portable and never destination-subtracted
  -- (BasisScope[]), and the private-conversation lineage behind it.
  ADD COLUMN "source_scopes" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "disclosure_sources" JSONB NOT NULL DEFAULT '[]'::JSONB,
  -- {brief, turn, turnAuthors, pendingAction}: the two monotone registers of
  -- the brief projection plus Nessie's own bookkeeping.
  ADD COLUMN "scope_json" JSONB,
  ADD COLUMN "failure_code" TEXT,
  -- Delivery: `full`, or `summary` when DeepWater could not write the full report.
  ADD COLUMN "report_kind" TEXT,
  ADD COLUMN "report_file_id" UUID,
  ADD COLUMN "sources_file_id" UUID,
  ADD COLUMN "result_message_id" UUID,
  ADD COLUMN "wake_message_id" UUID,
  ADD COLUMN "delivered_at" TIMESTAMP(3),
  ADD COLUMN "delivery_blocked_reason" TEXT,
  -- Agent wakes: at most eight per brief, one claim per planner turn.
  ADD COLUMN "agent_wake_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_handled_turn_seq" INTEGER,
  ADD COLUMN "wake_cap_notice_at" TIMESTAMP(3),
  -- The Ledger watch: when this projection last changed, when it is next due,
  -- and a sequence that keys each watch job.
  ADD COLUMN "ledger_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "reconcile_after" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '10 minutes'),
  ADD COLUMN "reconcile_seq" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_origin_kind_check"
    CHECK ("origin_kind" IN ('person', 'agent')),
  -- An agent-origin row is keyed by its tool call; without one it could never
  -- be found again by the binder that claimed it.
  ADD CONSTRAINT "product_integration_runs_agent_origin_tool_call_check"
    CHECK ("origin_kind" <> 'agent' OR "origin_tool_call_id" IS NOT NULL),
  -- Both brief insert paths write the captured identity and the brief state
  -- together; legacy launcher rows and other products write neither. So
  -- `uoa_identity IS NULL` is the exact legacy marker for deep-water rows.
  ADD CONSTRAINT "product_integration_runs_brief_binding_shape"
    CHECK (("scope_json" IS NULL) = ("uoa_identity" IS NULL)),
  ADD CONSTRAINT "product_integration_runs_report_kind_check"
    CHECK ("report_kind" IS NULL OR "report_kind" IN ('full', 'summary')),
  ADD CONSTRAINT "product_integration_runs_failure_code_check"
    CHECK ("failure_code" IS NULL OR "failure_code" ~ '^[a-z_]{1,64}$'),
  ADD CONSTRAINT "product_integration_runs_agent_wake_count_check"
    CHECK ("agent_wake_count" >= 0),
  ADD CONSTRAINT "product_integration_runs_source_scopes_array_check"
    CHECK (jsonb_typeof("source_scopes") = 'array'),
  ADD CONSTRAINT "product_integration_runs_disclosure_sources_array_check"
    CHECK (jsonb_typeof("disclosure_sources") = 'array');

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_origin_agent_id_fkey"
  FOREIGN KEY ("origin_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_origin_run_id_fkey"
  FOREIGN KEY ("origin_run_id") REFERENCES "runs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_principal_user_id_fkey"
  FOREIGN KEY ("principal_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_report_file_id_fkey"
  FOREIGN KEY ("report_file_id") REFERENCES "attachments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_sources_file_id_fkey"
  FOREIGN KEY ("sources_file_id") REFERENCES "attachments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_result_message_id_fkey"
  FOREIGN KEY ("result_message_id") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_integration_runs"
  ADD CONSTRAINT "product_integration_runs_wake_message_id_fkey"
  FOREIGN KEY ("wake_message_id") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "product_integration_runs_origin_agent_idx"
  ON "product_integration_runs"("origin_agent_id");
CREATE INDEX "product_integration_runs_origin_run_idx"
  ON "product_integration_runs"("origin_run_id");
CREATE INDEX "product_integration_runs_principal_user_idx"
  ON "product_integration_runs"("principal_user_id");
CREATE INDEX "product_integration_runs_report_file_idx"
  ON "product_integration_runs"("report_file_id");
CREATE INDEX "product_integration_runs_sources_file_idx"
  ON "product_integration_runs"("sources_file_id");
CREATE INDEX "product_integration_runs_result_message_idx"
  ON "product_integration_runs"("result_message_id");
CREATE INDEX "product_integration_runs_wake_message_idx"
  ON "product_integration_runs"("wake_message_id");

-- A Ledger research id names one research everywhere, so it may bind to at
-- most one product run — not merely one per organisation, which is all the
-- index this replaces promised. Refuse loudly rather than guess which of two
-- rows is the real owner.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "product_integration_runs"
    WHERE "external_run_id" IS NOT NULL
    GROUP BY "product_slug", "external_run_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'product_integration_runs has duplicate (product_slug, external_run_id) pairs; resolve them before applying 20260923090100_deepwater_research_binding';
  END IF;
END $$;

CREATE UNIQUE INDEX "product_integration_runs_product_external_run_key"
  ON "product_integration_runs"("product_slug", "external_run_id")
  WHERE "external_run_id" IS NOT NULL;

-- Superseded by the stricter index above, which also serves its lookups.
DROP INDEX IF EXISTS "product_integration_runs_org_product_external_run_key";

-- An agent's research_scope_start claims its row before dispatch; a retried
-- tool call finds the same row.
CREATE UNIQUE INDEX "product_integration_runs_agent_origin_key"
  ON "product_integration_runs"("organization_id", "origin_run_id", "origin_tool_call_id")
  WHERE "origin_kind" = 'agent';

-- A person's replayed create request (same actionId) finds the same brief.
CREATE UNIQUE INDEX "product_integration_runs_person_origin_key"
  ON "product_integration_runs"("organization_id", "requested_by_user_id", "origin_tool_call_id")
  WHERE "origin_kind" = 'person';

-- The Ledger watch claims due, open, bound brief runs in reconcile order.
CREATE INDEX "product_integration_runs_deep_water_watch_idx"
  ON "product_integration_runs"("reconcile_after")
  WHERE "product_slug" = 'deep-water'
    AND "uoa_identity" IS NOT NULL
    AND "external_run_id" IS NOT NULL
    AND "status" IN ('drafting', 'running', 'needs_setup')
    AND "delivery_blocked_reason" IS NULL;
