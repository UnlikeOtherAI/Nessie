ALTER TABLE "projects"
  ADD COLUMN "avatar_emoji" TEXT,
  ADD COLUMN "avatar_attachment_id" UUID;

CREATE INDEX "projects_avatar_attachment_id_idx" ON "projects"("avatar_attachment_id");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_avatar_attachment_id_fkey"
  FOREIGN KEY ("avatar_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
