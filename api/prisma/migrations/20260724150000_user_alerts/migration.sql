-- CreateEnum
CREATE TYPE "UserAlertKind" AS ENUM ('mention');

-- CreateTable
CREATE TABLE "user_alerts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "UserAlertKind" NOT NULL,
    "message_id" UUID,
    "thread_id" UUID,
    "channel_id" UUID,
    "actor_user_id" UUID,
    "actor_agent_id" UUID,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_alerts_user_id_read_at_created_at_idx" ON "user_alerts"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "user_alerts_organization_id_user_id_created_at_idx" ON "user_alerts"("organization_id", "user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_actor_agent_id_fkey" FOREIGN KEY ("actor_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
