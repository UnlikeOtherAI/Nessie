ALTER TABLE "messages" ADD COLUMN "edited_at" TIMESTAMP(3);
ALTER TABLE "messages" ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "messages_content_fts_idx" ON "messages" USING GIN (to_tsvector('english', "content"));
