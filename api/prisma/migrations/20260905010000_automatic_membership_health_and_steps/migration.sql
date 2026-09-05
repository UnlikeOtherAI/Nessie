-- Follow-ups to 20260904120000_automatic_membership_rules, found in review.
--
-- 1. `step` gives a reconciliation run a monotonically increasing counter to key
--    its queue jobs on. The first cut keyed retries on `attempts` and pages on
--    the cursor, and both are reused: `attempts` is reset to 0 after every
--    successful page, and a stale-cursor restart re-walks pages it has already
--    enqueued. `queue_jobs.idempotency_key` is uniquely indexed and its insert
--    is ON CONFLICT DO NOTHING, and nothing purges the table, so a reused key
--    silently enqueues nothing and the run stalls in `running` forever.
--
-- 2. `automatic_membership_health` lets a rule whose authorization stopped
--    verifying reach the people who can repair it, through the existing
--    user_alerts substrate and its (user_id, event_key) uniqueness — the
--    exactly-once contract in docs/standards/capability-health-alerts.md.
--    Without it the transition was audited and announced to nobody, which is
--    the precise failure that standard was written after.

ALTER TABLE "automatic_membership_reconciliations"
  ADD COLUMN "step" INTEGER NOT NULL DEFAULT 0;

ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'automatic_membership_health';
