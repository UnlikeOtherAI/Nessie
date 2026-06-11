-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "logo_attachment_id" UUID;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_logo_attachment_id_fkey" FOREIGN KEY ("logo_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
