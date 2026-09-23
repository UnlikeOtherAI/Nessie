-- A thought log's tool line names the ToolCall it became
-- (docs/plans/2026-09-22-executor-local-apps/screenshots.md §4).
--
-- Additive only: one nullable column, so it is compatible with the previous
-- release while it still serves.
--
-- `tool_call_id` is an app-enforced pointer, no FK — the `message_id`
-- precedent. The worker's thought recorder sets it when the call ends; every
-- read goes through the chunk's own run, which both rows cascade from, and the
-- thought log reads a call's screenshots through it.

ALTER TABLE "run_thinking_chunks" ADD COLUMN "tool_call_id" UUID;
