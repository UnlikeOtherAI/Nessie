-- The old invariant hard-coded "system_managed => personal_assistant", written
-- when the PA was the only system agent. System-managed *shared* agents (the
-- Librarian) are now legitimate: plain shared surface, no delegation.
ALTER TABLE "agents" DROP CONSTRAINT "agents_personal_assistant_system_invariants_chk";
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
);
