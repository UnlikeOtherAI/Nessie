-- Drop two redundant/unused indexes.
--
-- 1. agent_triggers (type, enabled, status, next_run_at) is a strict prefix of
--    (type, enabled, status, next_run_at, scheduler_claimed_at), which already
--    serves every query the shorter index could. Keeping both just doubles
--    write cost.
DROP INDEX IF EXISTS "agent_triggers_type_enabled_status_next_run_at_idx";

-- 2. tool_calls (agent_id, started_at) is unused: the only reader
--    (agents.ts buildToolCallTimeline) always filters by run_id (plus agent_id)
--    and orders by started_at, which is served by (run_id, started_at).
DROP INDEX IF EXISTS "tool_calls_agent_id_started_at_idx";
