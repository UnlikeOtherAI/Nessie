-- The Personal Assistant stays one organization-scoped Agent row. A member's
-- presence in a shared channel is therefore a fact about the binding, keyed by
-- the acting principal rather than copied onto the singleton agent or channel.
ALTER TABLE "agent_bindings"
  ADD COLUMN "principal_user_id" UUID;

-- The old compound unique admits only one PA binding in a channel. Keep that
-- exact invariant for ordinary bindings and add a distinct presence key.
DROP INDEX "agent_bindings_agent_id_channel_id_key";

CREATE UNIQUE INDEX "agent_bindings_ordinary_agent_channel_key"
  ON "agent_bindings"("agent_id", "channel_id")
  WHERE "principal_user_id" IS NULL;

CREATE UNIQUE INDEX "agent_bindings_presence_agent_channel_principal_key"
  ON "agent_bindings"("agent_id", "channel_id", "principal_user_id")
  WHERE "principal_user_id" IS NOT NULL;

-- A presence is valid only while its principal remains in the channel. This
-- cascade is the at-rest lifecycle invariant: every ChannelMember deletion,
-- not just the HTTP leave route, removes the corresponding PA presence.
ALTER TABLE "agent_bindings"
  ADD CONSTRAINT "agent_bindings_channel_id_principal_user_id_fkey"
  FOREIGN KEY ("channel_id", "principal_user_id")
  REFERENCES "channel_members"("channel_id", "user_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Extend the chunk-1 placement trigger rather than adding a second trigger
-- that can drift from the private-agent-home exception.
CREATE OR REPLACE FUNCTION "reject_private_agent_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_agent record;
  channel_organization_id uuid;
  channel_system_type "ChannelSystemType";
BEGIN
  SELECT "id", "agent_kind", "organization_id", "owner_user_id", "visibility"
  INTO bound_agent
  FROM "agents"
  WHERE "id" = NEW."agent_id";

  IF NEW."principal_user_id" IS NOT NULL THEN
    SELECT "organization_id", "system_channel_type"
    INTO channel_organization_id, channel_system_type
    FROM "channels"
    WHERE "id" = NEW."channel_id";

    IF NOT FOUND
       OR channel_system_type IS NOT NULL
       OR bound_agent."agent_kind" <> 'personal_assistant'::"AgentKind"
       OR bound_agent."organization_id" IS DISTINCT FROM channel_organization_id
       OR NOT EXISTS (
         SELECT 1
         FROM "organization_members" member
         WHERE member."organization_id" = channel_organization_id
           AND member."user_id" = NEW."principal_user_id"
           AND member."deactivated_at" IS NULL
       ) THEN
      RAISE EXCEPTION 'Personal Assistant presences require a live channel-organization member'
        USING ERRCODE = '23514',
              CONSTRAINT = 'agent_bindings_personal_assistant_presence';
    END IF;
  END IF;

  IF bound_agent."visibility" = 'private'::"AgentVisibility" AND NOT EXISTS (
    SELECT 1
    FROM "channels" channel
    WHERE channel."id" = NEW."channel_id"
      AND channel."organization_id" = bound_agent."organization_id"
      AND channel."type" = 'dm'
      AND channel."visibility" = 'private'
      AND channel."system_channel_type" IS NULL
      AND channel."dm_key" =
        'agent:' || bound_agent."organization_id"::text || ':'
        || bound_agent."owner_user_id"::text || ':' || bound_agent."id"::text
      AND (SELECT count(*) FROM "channel_members" member
           WHERE member."channel_id" = channel."id") = 1
      AND EXISTS (
        SELECT 1
        FROM "channel_members" member
        WHERE member."channel_id" = channel."id"
          AND member."user_id" = bound_agent."owner_user_id"
      )
  ) THEN
    RAISE EXCEPTION 'Private agents can only be bound to their owner home DM'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_bindings_private_agent_visibility';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE "messages"
  ADD COLUMN "on_behalf_of_user_id" UUID;

ALTER TABLE "message_reactions"
  ADD COLUMN "on_behalf_of_user_id" UUID;

-- Like bindings, an ordinary agent keeps its old reaction uniqueness while
-- singleton PA presences are independently attributable.
DROP INDEX "message_reactions_message_id_agent_id_emoji_key";

CREATE UNIQUE INDEX "message_reactions_ordinary_agent_emoji_key"
  ON "message_reactions"("message_id", "agent_id", "emoji")
  WHERE "on_behalf_of_user_id" IS NULL;

CREATE UNIQUE INDEX "message_reactions_presence_agent_emoji_key"
  ON "message_reactions"("message_id", "agent_id", "on_behalf_of_user_id", "emoji")
  WHERE "on_behalf_of_user_id" IS NOT NULL;

CREATE INDEX "message_reactions_message_agent_principal_idx"
  ON "message_reactions"("message_id", "agent_id", "on_behalf_of_user_id");

-- Run serialization is per PA presence, not merely per singleton agent. The
-- pending marker carries the same fact so an interrupted run drains into the
-- correct owner's follow-up rather than crossing presence boundaries.
ALTER TABLE "runs"
  ADD COLUMN "principal_user_id" UUID;

ALTER TABLE "run_thread_pending_messages"
  ADD COLUMN "principal_user_id" UUID;

DROP INDEX "run_thread_pending_messages_agent_id_message_id_key";

CREATE UNIQUE INDEX "run_thread_pending_messages_ordinary_agent_message_key"
  ON "run_thread_pending_messages"("agent_id", "message_id")
  WHERE "principal_user_id" IS NULL;

CREATE UNIQUE INDEX "run_thread_pending_messages_presence_agent_message_key"
  ON "run_thread_pending_messages"("agent_id", "message_id", "principal_user_id")
  WHERE "principal_user_id" IS NOT NULL;

CREATE INDEX "run_thread_pending_messages_agent_thread_principal_idx"
  ON "run_thread_pending_messages"("agent_id", "thread_id", "principal_user_id");
