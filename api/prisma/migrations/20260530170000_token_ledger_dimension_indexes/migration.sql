-- Per-project / per-team / per-channel token-ledger summary queries filter on
-- these columns (getTokenUsageSummary) but had no supporting index, forcing a
-- sequential scan over token_ledger_events. Add composite
-- (organization_id, <dimension>, occurred_at DESC) indexes to match the
-- existing provider/model/agent/actor index pattern.
CREATE INDEX "token_ledger_events_organization_id_project_id_occurred_at_idx" ON "token_ledger_events"("organization_id", "project_id", "occurred_at" DESC);
CREATE INDEX "token_ledger_events_organization_id_team_id_occurred_at_idx" ON "token_ledger_events"("organization_id", "team_id", "occurred_at" DESC);
CREATE INDEX "token_ledger_events_organization_id_channel_id_occurred_at_idx" ON "token_ledger_events"("organization_id", "channel_id", "occurred_at" DESC);
