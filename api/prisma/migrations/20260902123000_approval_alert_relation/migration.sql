-- Link an approval alert to its request so the bell item revalidates against
-- live status, the way trigger_health does: once the person approves, rejects,
-- or the request expires, the alert stops surfacing without anything having to
-- remember to delete it.
ALTER TABLE "user_alerts"
  ADD COLUMN "approval_request_id" UUID;

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_approval_request_id_fkey"
  FOREIGN KEY ("approval_request_id") REFERENCES "approval_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_alerts_approval_request_idx"
  ON "user_alerts" ("approval_request_id");
