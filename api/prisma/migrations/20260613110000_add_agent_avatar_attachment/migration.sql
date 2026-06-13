-- AlterTable
ALTER TABLE "agents" ADD COLUMN "avatar_attachment_id" UUID;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_avatar_attachment_id_fkey" FOREIGN KEY ("avatar_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "agents_avatar_attachment_id_idx" ON "agents"("avatar_attachment_id");
