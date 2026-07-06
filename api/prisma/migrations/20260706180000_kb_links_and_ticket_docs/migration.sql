-- Ticket binding: loose envelope column on pages + chunks (no FK, app-level
-- archive semantics on task deletion).
ALTER TABLE "knowledge_pages" ADD COLUMN "task_id" UUID;
CREATE INDEX "knowledge_pages_task_id_idx" ON "knowledge_pages"("task_id");
ALTER TABLE "knowledge_page_chunks" ADD COLUMN "task_id" UUID;
CREATE INDEX "knowledge_page_chunks_task_id_idx" ON "knowledge_page_chunks"("task_id");

-- Wikilink index: outgoing links per page, maintained with chunking on save.
CREATE TABLE "knowledge_page_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "source_page_id" UUID NOT NULL,
  "target_page_id" UUID,
  "target_title" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_page_links_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "knowledge_page_links"
  ADD CONSTRAINT "knowledge_page_links_source_page_id_fkey"
  FOREIGN KEY ("source_page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_page_links"
  ADD CONSTRAINT "knowledge_page_links_target_page_id_fkey"
  FOREIGN KEY ("target_page_id") REFERENCES "knowledge_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "knowledge_page_links_source_page_id_idx" ON "knowledge_page_links"("source_page_id");
CREATE INDEX "knowledge_page_links_target_page_id_idx" ON "knowledge_page_links"("target_page_id");
CREATE INDEX "knowledge_page_links_organization_id_target_title_idx" ON "knowledge_page_links"("organization_id", "target_title");
