-- Final push-delivery outcomes, recorded per targeted native device token.
--
-- Rows are organization-scoped and intentionally store provider/status/error
-- metadata without persisting the native device token text.

CREATE TYPE "PushDeliveryStatus" AS ENUM ('sent', 'failed', 'dead');

CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "message_id" UUID,
    "provider" "PushProvider" NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL,
    "error_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "push_deliveries_organization_id_created_at_idx"
    ON "push_deliveries"("organization_id", "created_at");

CREATE INDEX "push_deliveries_user_id_idx" ON "push_deliveries"("user_id");
