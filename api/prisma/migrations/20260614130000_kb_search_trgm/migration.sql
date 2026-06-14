-- Enable trigram matching so the knowledge search's ILIKE '%term%' predicates
-- (packages/knowledge/src/native-search.ts) can use a GIN index instead of
-- sequentially scanning knowledge_pages on every query.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "knowledge_pages_title_trgm_idx" ON "knowledge_pages" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "knowledge_pages_summary_trgm_idx" ON "knowledge_pages" USING GIN ("summary" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "page_labels_normalized_trgm_idx" ON "page_labels" USING GIN ("normalized_name" gin_trgm_ops);
