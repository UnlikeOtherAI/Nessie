-- A completed bridge request is replayed as its current aggregate outcome;
-- in-flight duplicate requests remain fenced until the original returns.
ALTER TABLE "uoa_automatic_membership_control_requests"
  ADD COLUMN "completed_at" timestamp(3);

CREATE INDEX "uoa_automatic_membership_control_requests_completed_at_idx"
  ON "uoa_automatic_membership_control_requests" ("completed_at");
