-- Global agents: app-provided blueprints instantiated as one system-managed row
-- per organisation, each reachable through a per-user private DM.
--
-- Three storage facts land here, all of them the "make it a database fact, not
-- prose" discipline the private-agent home and the external-agent surface
-- already follow:
--   1. `agents.system_slug` — the durable discriminator the ensure function
--      keys on (the Librarian's name-keying is the fragility this replaces),
--      unique per organisation and only ever set on a system-managed row that
--      HAS an organisation. The org-not-null arm is what makes "per-org rows,
--      nothing cross-org" impossible to violate rather than merely unusual.
--   2. The channel surface CHECK learns the `gagent:` DM key under its own
--      system-channel type. Adding `external_agent` to the enum without
--      teaching this constraint made every external-agent DM insert fail; the
--      new arm is keyed to `system_agent` rather than widening a pattern.
--   3. The deferred home-membership trigger learns `gagent:` keys. The owner is
--      segment 4 there (`gagent:{slug}:{orgId}:{userId}`) where an `agent:` key
--      carries it at segment 3 — later phases treat sole membership as an
--      identity fact (`effectiveUserId = poster`), so it must hold at rest.

-- 1. The system slug.
ALTER TABLE "agents" ADD COLUMN "system_slug" TEXT;

CREATE UNIQUE INDEX "agents_organization_id_system_slug_key"
  ON "agents" ("organization_id", "system_slug");

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_system_slug_scope_chk"
  CHECK (
    "system_slug" IS NULL
    OR ("system_managed" = true AND "organization_id" IS NOT NULL)
  );

-- 2. The channel surface rule. Every pre-existing arm is reproduced verbatim;
-- only the `system_agent` arm is new.
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
    -- A first-party external product's per-user DM.
    OR (
      "system_channel_type" = 'external_agent'
      AND "type" = 'dm'
      AND "visibility" = 'private'
      AND "dm_key" LIKE 'extagent:%'
    )
    -- A hosted agent mailbox's operations room: an ordinary standard channel,
    -- never a DM, carrying no dm_key — the agent_mailboxes row owns the pairing.
    OR (
      "system_channel_type" = 'agent_email'
      AND "type" = 'standard'
      AND "dm_key" IS NULL
    )
    -- A global agent's per-user home DM. Keyed to its own system-channel type
    -- rather than a widened pattern, so a `gagent:` key can never appear on any
    -- other kind of channel.
    OR (
      "system_channel_type" = 'system_agent'
      AND "type" = 'dm'
      AND "visibility" = 'private'
      AND "dm_key" LIKE 'gagent:%'
    )
  );

-- 3. The home-membership trigger, extended to the `gagent:` shape. `LIKE` is
-- anchored, so a `gagent:` key never matches the `agent:%` arm and the two
-- segment positions cannot be confused.
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
  SELECT (
    CASE
      WHEN "dm_key" LIKE 'agent:%' THEN split_part("dm_key", ':', 3)
      ELSE split_part("dm_key", ':', 4)
    END
  )::uuid
  INTO expected_owner_id
  FROM "channels"
  WHERE "id" = home_channel_id
    AND ("dm_key" LIKE 'agent:%' OR "dm_key" LIKE 'gagent:%');

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
    RAISE EXCEPTION 'An agent home DM must contain exactly its owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'channel_members_private_agent_home_owner';
  END IF;

  RETURN NULL;
END;
$$;
