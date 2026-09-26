ALTER TABLE "channels"
  ADD COLUMN "admin_only_posting" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "mandatory_announcements" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "messages"
  ADD COLUMN "is_announcement" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "requires_confirmation" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_confirmation_announcement_chk"
    CHECK (NOT "requires_confirmation" OR ("is_announcement" AND "role" = 'user'));

ALTER TABLE "user_alerts"
  ADD COLUMN "is_announcement" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE "announcement_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "recipient_user_id" UUID,
  "recipient_uoa_sub" TEXT,
  "seen_at" TIMESTAMP(3),
  "acknowledged_at" TIMESTAMP(3),
  "reminder_claimed_at" TIMESTAMP(3),
  "reminder_message_id" UUID,
  "reminder_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "announcement_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "announcement_deliveries_one_recipient_chk" CHECK (
    ("recipient_user_id" IS NULL) <> ("recipient_uoa_sub" IS NULL)
  ),
  CONSTRAINT "announcement_deliveries_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE,
  CONSTRAINT "announcement_deliveries_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "announcement_deliveries_message_user_key"
  ON "announcement_deliveries"("message_id", "recipient_user_id");
CREATE UNIQUE INDEX "announcement_deliveries_message_subject_key"
  ON "announcement_deliveries"("message_id", "recipient_uoa_sub");
CREATE INDEX "announcement_deliveries_subject_created_idx"
  ON "announcement_deliveries"("recipient_uoa_sub", "created_at");

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_announcement_controls_kind_chk"
    CHECK (
      (NOT "admin_only_posting" AND NOT "mandatory_announcements")
      OR ("type" = 'standard' AND "system_channel_type" IS NULL)
    ),
  ADD CONSTRAINT "channels_mandatory_public_chk"
    CHECK (NOT "mandatory_announcements" OR "visibility" = 'public');

-- Every writer, including workers and system tools, crosses this boundary.
-- A signed-in human API send sets the transaction-local author after its live
-- org/team role check. The SHARE lock serializes a send with a settings edit.
CREATE FUNCTION "guard_admin_only_channel_message"()
RETURNS TRIGGER AS $$
DECLARE
  is_read_only BOOLEAN;
  is_public BOOLEAN;
BEGIN
  SELECT c."admin_only_posting", c."visibility" = 'public' INTO is_read_only, is_public
  FROM "threads" t
  JOIN "channels" c ON c."id" = t."channel_id"
  WHERE t."id" = NEW."thread_id"
  FOR SHARE OF c;

  IF is_read_only AND (
    NEW."role" <> 'user'
    OR NEW."user_id" IS NULL
    OR current_setting('nessie.verified_channel_admin_user_id', TRUE)
      IS DISTINCT FROM NEW."user_id"::TEXT
  ) THEN
    RAISE EXCEPTION 'Only a verified channel administrator may post here'
      USING ERRCODE = '42501';
  END IF;
  IF NEW."requires_confirmation" AND (
    NOT is_read_only OR NOT is_public OR NEW."root_message_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Confirmation requires a top-level public read-only post'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "messages_admin_only_channel_guard"
  BEFORE INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION "guard_admin_only_channel_message"();

-- Refuse new automation targets as well as existing targets at activation.
-- All paths take a channel row lock, so binding and activation cannot cross.
CREATE FUNCTION "guard_read_only_channel_target"()
RETURNS TRIGGER AS $$
DECLARE
  target_channel_id UUID;
  is_read_only BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'agent_bindings' THEN
    target_channel_id := NEW."channel_id";
  ELSIF TG_TABLE_NAME = 'workflow_installations' THEN
    target_channel_id := NEW."channel_id";
  ELSE
    target_channel_id := NEW."target_channel_id";
    IF target_channel_id IS NULL AND NEW."target_thread_id" IS NOT NULL THEN
      SELECT "channel_id" INTO target_channel_id
      FROM "threads" WHERE "id" = NEW."target_thread_id";
    END IF;
  END IF;
  IF target_channel_id IS NULL THEN RETURN NEW; END IF;
  SELECT "admin_only_posting" INTO is_read_only FROM "channels"
  WHERE "id" = target_channel_id FOR SHARE;
  IF is_read_only THEN
    RAISE EXCEPTION 'An automation cannot target a read-only channel'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "agent_bindings_read_only_channel_guard"
  BEFORE INSERT OR UPDATE OF "channel_id" ON "agent_bindings"
  FOR EACH ROW EXECUTE FUNCTION "guard_read_only_channel_target"();
CREATE TRIGGER "agent_triggers_read_only_channel_guard"
  BEFORE INSERT OR UPDATE OF "target_channel_id", "target_thread_id" ON "agent_triggers"
  FOR EACH ROW EXECUTE FUNCTION "guard_read_only_channel_target"();
CREATE TRIGGER "workflow_installations_read_only_channel_guard"
  BEFORE INSERT OR UPDATE OF "channel_id" ON "workflow_installations"
  FOR EACH ROW EXECUTE FUNCTION "guard_read_only_channel_target"();

CREATE FUNCTION "guard_read_only_channel_activation"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."admin_only_posting" AND NOT OLD."admin_only_posting" AND (
    EXISTS (SELECT 1 FROM "agent_bindings" WHERE "channel_id" = NEW."id")
    OR EXISTS (SELECT 1 FROM "agent_triggers" WHERE "target_channel_id" = NEW."id")
    OR EXISTS (
      SELECT 1 FROM "agent_triggers" a
      JOIN "threads" t ON t."id" = a."target_thread_id"
      WHERE t."channel_id" = NEW."id"
    )
    OR EXISTS (SELECT 1 FROM "workflow_installations" WHERE "channel_id" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'Remove automation targets before enabling read-only posting'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "channels_read_only_activation_guard"
  BEFORE UPDATE OF "admin_only_posting" ON "channels"
  FOR EACH ROW EXECUTE FUNCTION "guard_read_only_channel_activation"();

CREATE FUNCTION "guard_channel_confirmation_visibility"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."visibility" <> 'public' AND OLD."visibility" = 'public'
    AND EXISTS (
      SELECT 1 FROM "messages" m JOIN "threads" t ON t."id" = m."thread_id"
      WHERE t."channel_id" = NEW."id" AND m."requires_confirmation"
        AND m."deleted_at" IS NULL
    ) THEN
    RAISE EXCEPTION 'Active confirmations require a public channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "channels_confirmation_visibility_guard"
  BEFORE UPDATE OF "visibility" ON "channels"
  FOR EACH ROW EXECUTE FUNCTION "guard_channel_confirmation_visibility"();
