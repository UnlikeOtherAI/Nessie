-- Budget period sums (scopeUsageWhere) query token_ledger_events by project_id
-- or team_id ALONE — the existing indexes all lead with organization_id, so
-- project/team budget checks couldn't use an index on the leading column.
-- CreateIndex
CREATE INDEX "token_ledger_events_project_id_occurred_at_idx" ON "token_ledger_events"("project_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "token_ledger_events_team_id_occurred_at_idx" ON "token_ledger_events"("team_id", "occurred_at" DESC);
