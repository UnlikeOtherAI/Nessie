-- A one-message disclosure grant approves the exact body a person reviewed.
-- Every body replacement serializes with grant creation and revokes active
-- grants before the replacement can become visible.
CREATE OR REPLACE FUNCTION "revoke_message_disclosure_grants_on_content_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('disclosure-message:' || NEW."id"::text, 0)
  );

  UPDATE "disclosure_grants"
  SET "revoked_at" = CURRENT_TIMESTAMP
  WHERE "message_id" = NEW."id"
    AND "revoked_at" IS NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "messages_revoke_disclosure_grants_on_content_change"
BEFORE UPDATE OF "content" ON "messages"
FOR EACH ROW
WHEN (OLD."content" IS DISTINCT FROM NEW."content")
EXECUTE FUNCTION "revoke_message_disclosure_grants_on_content_change"();