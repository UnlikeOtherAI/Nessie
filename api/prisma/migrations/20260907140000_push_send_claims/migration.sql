-- Exactly-once push claims: the durable guard that stops a redelivered
-- dispatch job notifying the same device twice (horizontal-scaling audit 5.13).
--
-- `push_deliveries` is an outcome log written after the provider answers. It
-- has no unique key and is pruned on ops' own horizon, so it can never decide
-- whether a send already happened. A `push.dispatch` job that is redelivered —
-- a dropped ack during a drain, a lock expiry, a nack-and-retry — therefore
-- sent the notification again, and with N workers every drain and every
-- scale-in could cause it.
--
-- A row here is inserted BEFORE any provider call. The unique
-- `(organization_id, notification_key, endpoint_key)` makes exactly one caller
-- the sender; every later claimant loses the INSERT ... ON CONFLICT DO NOTHING
-- and skips the send, while the job itself still succeeds.
--
-- `notification_key` is the notification's durable identity and matches the
-- enqueue idempotency key one-for-one (`push:message:<id>`,
-- `push:attention:<alertId>`, `push:call:ring:<callId>:<userId>:<revision>`).
-- `endpoint_key` is a SHA-256 over the transport + device token / subscription
-- endpoint, so no push credential is copied into this table and the claim
-- survives a token row being pruned and re-registered.
CREATE TABLE "push_send_claims" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "notification_key" TEXT NOT NULL,
    "endpoint_key" TEXT NOT NULL,
    "provider" "PushProvider" NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_send_claims_pkey" PRIMARY KEY ("id")
);

-- The guarantee. Without this index the table is another log.
CREATE UNIQUE INDEX "push_send_claims_notification_endpoint_key" ON "push_send_claims"("organization_id", "notification_key", "endpoint_key");

-- Claims are reaped by age, not by tenant.
CREATE INDEX "push_send_claims_claimed_at_idx" ON "push_send_claims"("claimed_at");

ALTER TABLE "push_send_claims" ADD CONSTRAINT "push_send_claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
