-- An external-agent product (DeepSignal) is a peer of the Personal Assistant:
-- a system-managed *shared* agent that lives only in a per-user private DM and
-- acts as the requesting user. Both storage invariants were written before it
-- existed, and neither was extended when `external_agent` joined
-- "ChannelSystemType" — so `ensureExternalAgentBootstrap` has always failed
-- against a real database, twice over. Only a cast Prisma fake in the tests hid
-- it. Sanction the two shapes it writes; every pre-existing arm is unchanged.

-- The 2026-07-06 invariant sanctioned three agent tuples. Add the fourth:
-- system-managed + shared + dm_only + act_as_requesting_user.
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
);

-- The channel surface rule knew only the PA's `pa:` DM key. An external-agent
-- channel is the same shape under its own key, so it gets its own arm keyed to
-- its own system-channel type rather than a widened `pa:%` pattern.
ALTER TABLE "channels"
  DROP CONSTRAINT "channels_personal_assistant_surface_chk";

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_personal_assistant_surface_chk"
  CHECK (
    (
      "system_channel_type" IS NULL
      AND (
        "dm_key" IS NULL
        OR "dm_key" NOT LIKE 'agent:%'
        OR (
          "type" = 'dm'
          AND "visibility" = 'private'
          AND "dm_key" ~ '^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
      )
    )
    OR (
      "type" = 'dm'
      AND "visibility" = 'private'
      AND "dm_key" LIKE 'pa:%'
    )
    OR (
      "system_channel_type" = 'external_agent'
      AND "type" = 'dm'
      AND "visibility" = 'private'
      AND "dm_key" LIKE 'extagent:%'
    )
  );
