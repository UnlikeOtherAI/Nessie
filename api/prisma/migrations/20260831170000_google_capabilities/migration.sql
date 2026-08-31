-- Google capability catalog support on a communications connection.
--
-- All additive and all defaulted, so existing rows keep working unchanged:
-- a connection with no recorded capabilities simply has none blocked, and
-- `granted_scopes` remains the sole authority for what it may do.
--
-- `provider_account_id` is nullable because rows created before this migration
-- were identified from Gmail's users.getProfile and never captured Google's
-- stable subject. It is backfilled naturally on the next re-authorization.

ALTER TABLE "comms_connections"
  ADD COLUMN "requested_capabilities" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "disabled_capabilities" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "provider_account_id" TEXT;
