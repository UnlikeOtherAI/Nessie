-- Carry agent tool policy across the workspace->team rename.
--
-- `Agent.toolPolicy` is a persisted `Record<toolId, boolean>` deny map, and
-- `hasPolicyDeny` (worker/src/run/tool-policy.ts) looks a tool up by its
-- current id. The workspace->team rename changed the built-in tool id
-- `workspace_search` to `team_search` in code only, so every agent that had
-- been denied the old id silently regained the tool: the lookup missed, and
-- `authorizeToolCall` allowed the call. This is a policy bypass on existing
-- rows, not a display problem, so the stored keys move with the code.
--
-- Both statements are guarded, so re-running changes nothing.

-- An explicit `team_search` decision already reflects the operator's intent
-- under the new name; the stale key is just dropped.
UPDATE "agents"
SET "tool_policy" = "tool_policy" - 'workspace_search'
WHERE "tool_policy" ? 'workspace_search'
  AND "tool_policy" ? 'team_search';

-- Otherwise the decision moves to the new id, keeping its boolean — a deny
-- stays a deny, and an explicit allow stays an allow.
UPDATE "agents"
SET "tool_policy" = ("tool_policy" - 'workspace_search')
  || jsonb_build_object('team_search', "tool_policy" -> 'workspace_search')
WHERE "tool_policy" ? 'workspace_search';

-- Recorded tool names elsewhere (tool_calls, approval_requests,
-- demonstration_steps, voice_tool_calls) are history: they name the tool as it
-- was called at the time, are never re-matched against a live id, and are
-- deliberately left alone.
