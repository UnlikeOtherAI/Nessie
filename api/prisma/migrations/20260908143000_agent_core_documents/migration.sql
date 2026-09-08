-- Typed documents and exact core revisions. Core status comes from the
-- existing KnowledgePage publication pointer; drafts never become active by
-- virtue of being the newest version.
CREATE TYPE "KnowledgeDocumentRole" AS ENUM (
  'identity', 'working_rules', 'knowledge', 'template', 'example', 'procedure', 'experience'
);
CREATE TYPE "KnowledgeDocumentTrust" AS ENUM (
  'observed', 'explicitly_confirmed', 'inferred', 'unverified_import'
);
CREATE TYPE "KnowledgeDocumentOrigin" AS ENUM (
  'user_authored', 'agent_authored', 'legacy_migration', 'import'
);
CREATE TYPE "KnowledgeDocumentEvidenceSourceType" AS ENUM (
  'message', 'document_version', 'run', 'outcome'
);
CREATE TYPE "AgentCoreDocumentRole" AS ENUM ('identity', 'working_rules');

ALTER TABLE "knowledge_pages"
  ADD COLUMN "document_role" "KnowledgeDocumentRole" NOT NULL DEFAULT 'knowledge';
ALTER TABLE "knowledge_page_versions"
  ADD COLUMN "trust" "KnowledgeDocumentTrust" NOT NULL DEFAULT 'unverified_import',
  ADD COLUMN "origin" "KnowledgeDocumentOrigin" NOT NULL DEFAULT 'user_authored';

CREATE TABLE "knowledge_document_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "version_id" UUID NOT NULL,
  "source_type" "KnowledgeDocumentEvidenceSourceType" NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_version_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "knowledge_document_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "knowledge_document_evidence_version_id_source_type_source_id_source_version_id_key"
  ON "knowledge_document_evidence"("version_id", "source_type", "source_id", "source_version_id");
CREATE INDEX "knowledge_document_evidence_source_type_source_id_idx"
  ON "knowledge_document_evidence"("source_type", "source_id");
ALTER TABLE "knowledge_document_evidence"
  ADD CONSTRAINT "knowledge_document_evidence_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "knowledge_page_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_core_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "page_id" UUID NOT NULL,
  "role" "AgentCoreDocumentRole" NOT NULL,
  "legacy_source_hash" TEXT,
  "migrated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_core_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_core_documents_page_id_key" ON "agent_core_documents"("page_id");
CREATE UNIQUE INDEX "agent_core_documents_agent_id_role_key" ON "agent_core_documents"("agent_id", "role");
CREATE INDEX "agent_core_documents_agent_id_idx" ON "agent_core_documents"("agent_id");
ALTER TABLE "agent_core_documents"
  ADD CONSTRAINT "agent_core_documents_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_core_documents_page_id_fkey"
  FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_core_document_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "role" "AgentCoreDocumentRole" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "run_core_document_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "run_core_document_snapshots_run_id_role_key"
  ON "run_core_document_snapshots"("run_id", "role");
CREATE INDEX "run_core_document_snapshots_version_id_idx"
  ON "run_core_document_snapshots"("version_id");
ALTER TABLE "run_core_document_snapshots"
  ADD CONSTRAINT "run_core_document_snapshots_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "run_core_document_snapshots_version_id_fkey"
  FOREIGN KEY ("version_id") REFERENCES "knowledge_page_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "knowledge_pages_space_role_idx" ON "knowledge_pages"("space_id", "document_role");

CREATE TABLE "personal_agent_core_overlays" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "page_id" UUID NOT NULL,
  "role" "AgentCoreDocumentRole" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "personal_agent_core_overlays_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "personal_agent_core_overlays_page_id_key" ON "personal_agent_core_overlays"("page_id");
CREATE UNIQUE INDEX "personal_agent_core_overlays_agent_id_user_id_role_key"
  ON "personal_agent_core_overlays"("agent_id", "user_id", "role");
CREATE INDEX "personal_agent_core_overlays_organization_id_user_id_idx"
  ON "personal_agent_core_overlays"("organization_id", "user_id");
ALTER TABLE "personal_agent_core_overlays"
  ADD CONSTRAINT "personal_agent_core_overlays_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "personal_agent_core_overlays_page_id_fkey"
  FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
