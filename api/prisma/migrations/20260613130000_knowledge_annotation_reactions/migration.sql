-- CreateTable
CREATE TABLE "knowledge_page_annotation_reactions" (
    "id" UUID NOT NULL,
    "annotation_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "agent_id" UUID,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_page_annotation_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_annotation_reactions_user_emoji_key" ON "knowledge_page_annotation_reactions"("annotation_id", "user_id", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "kb_annotation_reactions_agent_emoji_key" ON "knowledge_page_annotation_reactions"("annotation_id", "agent_id", "emoji");

-- CreateIndex
CREATE INDEX "kb_annotation_reactions_annotation_idx" ON "knowledge_page_annotation_reactions"("annotation_id");

-- AddForeignKey
ALTER TABLE "knowledge_page_annotation_reactions" ADD CONSTRAINT "knowledge_page_annotation_reactions_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "knowledge_page_annotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
