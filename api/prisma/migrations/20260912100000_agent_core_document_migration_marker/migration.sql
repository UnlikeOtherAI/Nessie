-- A legacy agent with no configured core text still needs a durable cutover
-- marker, otherwise concurrent provisioners cannot distinguish it from a
-- migration that has not begun.
CREATE TABLE "agent_core_document_migrations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "document_count" INTEGER NOT NULL,
  "source_hash" TEXT NOT NULL,
  "migrated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_core_document_migrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_core_document_migrations_agent_id_key"
  ON "agent_core_document_migrations"("agent_id");
CREATE INDEX "agent_core_document_migrations_organization_id_idx"
  ON "agent_core_document_migrations"("organization_id");
ALTER TABLE "agent_core_document_migrations"
  ADD CONSTRAINT "agent_core_document_migrations_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
