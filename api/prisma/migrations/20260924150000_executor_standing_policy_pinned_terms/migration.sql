-- Standing machine access pins what its author agreed to
-- (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "What is
-- pinned"). `trigger_digest` is the digest of exactly these terms: the
-- trigger's security-relevant fields and every limit, the policy's own
-- `ticketHours`, `ticketUsd` and `dailyUsd` among them. Kept beside the digest
-- so the binder can recompute it and a fresh card can say which of them
-- changed since the last confirmation. Additive: nothing wrote a policy before
-- this column, and the default is never read as terms.
ALTER TABLE "executor_standing_policies"
  ADD COLUMN "pinned_terms" JSONB NOT NULL DEFAULT '{}';
