-- A global agent can now be placed in an ordinary channel.
--
-- `bindAgentToChannel` refused every `systemManaged` agent, which made an
-- app-provided shared agent -- the Agent Designer -- "available to everyone,
-- placeable nowhere": the unreachable-capability defect Rule zero names. The
-- refusal narrows to the Personal Assistant (its own presence path) and
-- external-agent products (their own per-user product DM); the system-*channel*
-- refusal is untouched, so every single-agent system DM still takes exactly one
-- agent.
--
-- The stored row has to stop claiming otherwise. `surface_policy = 'dm_only'`
-- is the storage-level statement "this agent lives only in a per-user private
-- DM", and for a global agent that is no longer true, so `ensureGlobalAgent`
-- now writes `'shared'`. `delegation_mode` stays `act_as_requesting_user` and
-- is unchanged in meaning: acting as the requesting person is gated on the
-- agent's own home DM in code (`isGlobalAgentHomeSurface`), which is what keeps
-- the identity-delegated tools out of a shared room.
--
-- Only that fifth tuple is added. Every pre-existing arm is byte-identical, and
-- nothing else about the constraint is relaxed.
ALTER TABLE "agents" DROP CONSTRAINT "agents_system_managed_invariants_chk";
ALTER TABLE "agents" ADD CONSTRAINT "agents_system_managed_invariants_chk" CHECK (
  (system_managed = false AND agent_kind = 'shared'::"AgentKind"
    AND surface_policy = 'shared'::"AgentSurfacePolicy"
    AND delegation_mode = 'none'::"AgentDelegationMode")
  OR (system_managed = true AND agent_kind = 'personal_assistant'::"AgentKind"
    AND surface_policy = 'dm_only'::"AgentSurfacePolicy"
    AND delegation_mode = 'act_as_requesting_user'::"AgentDelegationMode")
  OR (system_managed = true AND agent_kind = 'shared'::"AgentKind"
    AND surface_policy = 'shared'::"AgentSurfacePolicy"
    AND delegation_mode = 'none'::"AgentDelegationMode")
  OR (system_managed = true AND agent_kind = 'shared'::"AgentKind"
    AND surface_policy = 'dm_only'::"AgentSurfacePolicy"
    AND delegation_mode = 'act_as_requesting_user'::"AgentDelegationMode")
  OR (system_managed = true AND agent_kind = 'shared'::"AgentKind"
    AND surface_policy = 'shared'::"AgentSurfacePolicy"
    AND delegation_mode = 'act_as_requesting_user'::"AgentDelegationMode")
);

-- Existing global-agent rows carry the old policy until their next bootstrap.
-- Re-state it here so the fact is true immediately after `migrate deploy`,
-- rather than at whatever moment the next login happens to run the ensure.
UPDATE "agents"
SET "surface_policy" = 'shared'::"AgentSurfacePolicy"
WHERE "system_managed" = true
  AND "system_slug" IS NOT NULL
  AND "surface_policy" = 'dm_only'::"AgentSurfacePolicy";
