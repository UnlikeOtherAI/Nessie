-- Private agents have exactly one legitimate binding: their owner-only home DM.
-- The old trigger correctly rejects every private binding; replace it with the
-- narrow storage-level exception rather than trusting the creation service.
CREATE OR REPLACE FUNCTION "reject_private_agent_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  private_agent record;
BEGIN
  SELECT "id", "organization_id", "owner_user_id"
  INTO private_agent
  FROM "agents"
  WHERE "id" = NEW."agent_id"
    AND "visibility" = 'private'::"AgentVisibility";

  IF FOUND AND NOT EXISTS (
    SELECT 1
    FROM "channels" channel
    WHERE channel."id" = NEW."channel_id"
      AND channel."organization_id" = private_agent."organization_id"
      AND channel."type" = 'dm'
      AND channel."visibility" = 'private'
      AND channel."system_channel_type" IS NULL
      AND channel."dm_key" =
        'agent:' || private_agent."organization_id"::text || ':'
        || private_agent."owner_user_id"::text || ':' || private_agent."id"::text
      AND (SELECT count(*) FROM "channel_members" member
           WHERE member."channel_id" = channel."id") = 1
      AND EXISTS (
        SELECT 1
        FROM "channel_members" member
        WHERE member."channel_id" = channel."id"
          AND member."user_id" = private_agent."owner_user_id"
      )
  ) THEN
    RAISE EXCEPTION 'Private agents can only be bound to their owner home DM'
      USING ERRCODE = '23514',
            CONSTRAINT = 'agent_bindings_private_agent_visibility';
  END IF;

  RETURN NEW;
END;
$$;

-- `agent:` is a private-DM shape, never a system-channel shape. Extend the
-- existing PA surface constraint itself so every dm_key/system-channel rule
-- knows the new shape rather than leaving two rules that can drift.
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
  );

-- A home DM must retain exactly its named owner. Deferred enforcement permits
-- idempotent repair to upsert the owner then remove stale members in one tx;
-- direct additions or removals cannot commit a widened or empty home.
CREATE OR REPLACE FUNCTION "assert_private_agent_home_members"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  home_channel_id uuid;
  expected_owner_id uuid;
  actual_members integer;
BEGIN
  home_channel_id := COALESCE(NEW."channel_id", OLD."channel_id");
  SELECT split_part("dm_key", ':', 3)::uuid
  INTO expected_owner_id
  FROM "channels"
  WHERE "id" = home_channel_id
    AND "dm_key" LIKE 'agent:%';

  IF expected_owner_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*)
  INTO actual_members
  FROM "channel_members"
  WHERE "channel_id" = home_channel_id;

  IF actual_members <> 1 OR NOT EXISTS (
    SELECT 1
    FROM "channel_members"
    WHERE "channel_id" = home_channel_id
      AND "user_id" = expected_owner_id
  ) THEN
    RAISE EXCEPTION 'A private agent home DM must contain exactly its owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'channel_members_private_agent_home_owner';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "channel_members_private_agent_home_owner_trg"
AFTER INSERT OR UPDATE OR DELETE ON "channel_members"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_private_agent_home_members"();
