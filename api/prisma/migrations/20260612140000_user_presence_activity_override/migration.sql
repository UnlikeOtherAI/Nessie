-- CreateEnum
CREATE TYPE "UserPresenceManualState" AS ENUM ('active', 'away');

-- AlterTable
ALTER TABLE "user_presence" ADD COLUMN "last_active_at" TIMESTAMP(3);
ALTER TABLE "user_presence" ADD COLUMN "manual_state" "UserPresenceManualState";

-- CreateIndex
CREATE INDEX "user_presence_organization_id_idx" ON "user_presence"("organization_id");
