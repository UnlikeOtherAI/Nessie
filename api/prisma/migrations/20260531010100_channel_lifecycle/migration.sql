ALTER TABLE "channels" ADD COLUMN "topic" TEXT;
ALTER TABLE "channels" ADD COLUMN "description" TEXT;
ALTER TABLE "channels" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "channel_members" ADD COLUMN "role" "MemberRole" NOT NULL DEFAULT 'member';
