-- A ToolCall row that is one step of another call
-- (docs/executor-protocol/host-coding-sessions.md → "The agent's tools").
-- A coding-session wait reads the session every five seconds, and each read is
-- an executor command that needs a ToolCall of its own; the later reads name
-- the wait's own row here, so the run's tool-call views show the wait once
-- rather than a row per read.
--
-- Additive only: one nullable column, so it is compatible with the previous
-- release while it still serves.
--
-- `parent_tool_call_id` is an app-enforced pointer, no FK — the
-- `run_thinking_chunks.tool_call_id` precedent. Both rows belong to the same
-- run and cascade from it.

ALTER TABLE "tool_calls" ADD COLUMN "parent_tool_call_id" UUID;
