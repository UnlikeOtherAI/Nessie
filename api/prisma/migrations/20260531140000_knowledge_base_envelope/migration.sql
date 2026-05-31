ALTER TYPE "PolicyResourceType" ADD VALUE 'knowledge_space';
ALTER TYPE "PolicyResourceType" ADD VALUE 'knowledge_page';

CREATE TYPE "KnowledgePageStatus" AS ENUM ('draft', 'published', 'archived');
CREATE TYPE "KnowledgeAuthorType" AS ENUM ('user', 'agent');

CREATE TABLE "knowledge_spaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "private_to_agent_id" UUID,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "team_id" UUID,
    "channel_id" UUID,
    "thread_id" UUID,
    "user_id" UUID,
    "visibility" "ThoughtVisibility" NOT NULL DEFAULT 'project',
    "sensitivity_tier" "SensitivityTier" NOT NULL DEFAULT 'normal',
    "created_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_spaces_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "space_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "metadata" JSONB,
    "parent_page_id" UUID,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "KnowledgePageStatus" NOT NULL DEFAULT 'draft',
    "published_version_id" UUID,
    "private_to_agent_id" UUID,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "team_id" UUID,
    "channel_id" UUID,
    "thread_id" UUID,
    "user_id" UUID,
    "visibility" "ThoughtVisibility" NOT NULL DEFAULT 'project',
    "sensitivity_tier" "SensitivityTier" NOT NULL DEFAULT 'normal',
    "created_by" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_page_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "page_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "body" TEXT,
    "body_ref" TEXT,
    "author_type" "KnowledgeAuthorType" NOT NULL,
    "author_id" TEXT NOT NULL,
    "change_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_page_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "page_labels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_pages_published_version_id_key"
ON "knowledge_pages"("published_version_id");

CREATE INDEX "knowledge_spaces_org_project_updated_id_idx"
ON "knowledge_spaces"("organization_id", "project_id", "updated_at" DESC, "id" DESC);

CREATE INDEX "knowledge_spaces_org_visibility_updated_idx"
ON "knowledge_spaces"("organization_id", "visibility", "updated_at");

CREATE INDEX "knowledge_spaces_org_sensitivity_idx"
ON "knowledge_spaces"("organization_id", "sensitivity_tier");

CREATE INDEX "knowledge_spaces_private_to_agent_id_idx"
ON "knowledge_spaces"("private_to_agent_id");

CREATE INDEX "knowledge_pages_org_project_updated_id_idx"
ON "knowledge_pages"("organization_id", "project_id", "updated_at" DESC, "id" DESC);

CREATE INDEX "knowledge_pages_org_visibility_updated_idx"
ON "knowledge_pages"("organization_id", "visibility", "updated_at");

CREATE INDEX "knowledge_pages_org_sensitivity_idx"
ON "knowledge_pages"("organization_id", "sensitivity_tier");

CREATE INDEX "knowledge_pages_space_parent_position_idx"
ON "knowledge_pages"("space_id", "parent_page_id", "position");

CREATE INDEX "knowledge_pages_published_version_id_idx"
ON "knowledge_pages"("published_version_id");

CREATE INDEX "knowledge_pages_private_to_agent_id_idx"
ON "knowledge_pages"("private_to_agent_id");

CREATE UNIQUE INDEX "knowledge_page_versions_page_version_key"
ON "knowledge_page_versions"("page_id", "version_number");

CREATE INDEX "knowledge_page_versions_page_created_idx"
ON "knowledge_page_versions"("page_id", "created_at" DESC);

CREATE UNIQUE INDEX "page_labels_page_normalized_key"
ON "page_labels"("page_id", "normalized_name");

CREATE INDEX "page_labels_org_normalized_idx"
ON "page_labels"("organization_id", "normalized_name");

ALTER TABLE "knowledge_spaces"
ADD CONSTRAINT "knowledge_spaces_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_pages"
ADD CONSTRAINT "knowledge_pages_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_pages"
ADD CONSTRAINT "knowledge_pages_space_id_fkey"
FOREIGN KEY ("space_id") REFERENCES "knowledge_spaces"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_pages"
ADD CONSTRAINT "knowledge_pages_parent_page_id_fkey"
FOREIGN KEY ("parent_page_id") REFERENCES "knowledge_pages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "knowledge_page_versions"
ADD CONSTRAINT "knowledge_page_versions_page_id_fkey"
FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_pages"
ADD CONSTRAINT "knowledge_pages_published_version_id_fkey"
FOREIGN KEY ("published_version_id") REFERENCES "knowledge_page_versions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "page_labels"
ADD CONSTRAINT "page_labels_page_id_fkey"
FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
