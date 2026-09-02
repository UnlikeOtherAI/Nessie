-- Teach the channel surface constraint every system channel type there is.
--
-- `channels_personal_assistant_surface_chk` was written when
-- `personal_assistant` was the ONLY member of `ChannelSystemType`, so it reads
-- "system_channel_type IS NULL, or this is a `pa:` DM". Two members have been
-- added since:
--
--   * `external_agent` (the per-user DeepSignal-style product DM, `extagent:`)
--     was added to the enum without extending this constraint, so inserting one
--     has been failing the check ever since — verified against a clean database
--     built from this migration chain;
--   * `agent_email` (a hosted mailbox's operations room) is a *standard*
--     channel with no dm_key at all, so it does not fit the DM shape either.
--
-- Following the precedent set when `agent:` private homes landed, the fix is to
-- extend this one constraint rather than add a second rule beside it that can
-- drift: every dm_key/system-channel pairing is stated in one place.

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
      "system_channel_type" = 'personal_assistant'
      AND "type" = 'dm'
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
    -- never a DM, and it carries no dm_key — the mailbox row owns the pairing.
    OR (
      "system_channel_type" = 'agent_email'
      AND "type" = 'standard'
      AND "dm_key" IS NULL
    )
  );
