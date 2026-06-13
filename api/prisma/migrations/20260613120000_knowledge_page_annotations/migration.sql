-- CreateEnum
CREATE TYPE "KnowledgeAnnotationKind" AS ENUM ('comment', 'note');

-- CreateEnum
CREATE TYPE "KnowledgeAnnotationState" AS ENUM ('open', 'resolved');

-- CreateTable
CREATE TABLE "knowledge_page_annotations" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "space_id" UUID NOT NULL,
    "kind" "KnowledgeAnnotationKind" NOT NULL,
    "state" "KnowledgeAnnotationState" NOT NULL DEFAULT 'open',
    "parent_id" UUID,
    "body" TEXT NOT NULL,
    "author_type" "KnowledgeAuthorType" NOT NULL,
    "author_id" TEXT NOT NULL,
    "delegated_by_agent_id" UUID,
    "anchor" JSONB,
    "anchor_version_id" UUID,
    "orphaned" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_type" "KnowledgeAuthorType",
    "resolved_by_id" TEXT,
    "organization_id" UUID NOT NULL,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_page_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_annotations_page_kind_parent_created_idx" ON "knowledge_page_annotations"("page_id", "kind", "parent_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kb_annotations_org_page_idx" ON "knowledge_page_annotations"("organization_id", "page_id");

-- CreateIndex
CREATE INDEX "kb_annotations_parent_idx" ON "knowledge_page_annotations"("parent_id");

-- AddForeignKey
ALTER TABLE "knowledge_page_annotations" ADD CONSTRAINT "knowledge_page_annotations_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_page_annotations" ADD CONSTRAINT "knowledge_page_annotations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "knowledge_page_annotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
