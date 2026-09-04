-- A short-lived, durable replay ledger for the signed UOA control bridge.
-- It stores no profile data or request body, only a request digest and the
-- stable UOA subject that UOA already owns.
CREATE TABLE "uoa_automatic_membership_control_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL,
  "request_digest" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "uoa_actor_sub" text NOT NULL,
  "action" text NOT NULL,
  "received_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" timestamp(3) NOT NULL,
  CONSTRAINT "uoa_automatic_membership_control_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uoa_automatic_membership_control_requests_request_id_key" UNIQUE ("request_id"),
  CONSTRAINT "uoa_automatic_membership_control_requests_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "uoa_automatic_membership_control_requests_expires_at_idx"
  ON "uoa_automatic_membership_control_requests" ("expires_at");
CREATE INDEX "uoa_automatic_membership_control_requests_organization_id_received_at_idx"
  ON "uoa_automatic_membership_control_requests" ("organization_id", "received_at");
