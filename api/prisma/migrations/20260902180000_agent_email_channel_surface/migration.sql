-- Re-add the hosted-mailbox arm to the channel surface constraint.
--
-- Two changes landed against this one constraint on the same day, from two
-- directions: 20260902150000 taught it `agent_email` (a hosted agent mailbox's
-- operations room), and 20260902170000 taught it `external_agent` — each
-- rebuilding the whole CHECK from the version it could see. The later one wins
-- in a fresh database, so the `agent_email` arm needs restating on top of it.
--
-- Written as the full constraint again, deliberately: this rule is one
-- statement about which system-channel shapes may exist, and a reader must be
-- able to see all of them in the definition that is actually installed.

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
    -- The personal assistant's own DM.
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
  );
