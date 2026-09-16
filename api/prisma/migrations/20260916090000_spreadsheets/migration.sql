-- Spreadsheets as a knowledge-page kind.
--
-- The canonical state of a spreadsheet is an IronCalc workbook: `hot_snapshot`
-- (UserModel.toBytes()) plus every journal batch after `hot_snapshot_seq`
-- rebuilds it identically on any replica. The journal is the total order, and
-- `seq` is assigned by the one write door under a per-page advisory lock.
--
-- Nothing here backfills: there are no spreadsheets yet, and a `document` or
-- `file` page is untouched by the new enum value.

-- A new enum value cannot be used in the same transaction that adds it on
-- PostgreSQL < 12 semantics for some clients; Prisma runs each migration file
-- in its own transaction and nothing below writes the value, so this is safe.
ALTER TYPE "KnowledgePageKind" ADD VALUE IF NOT EXISTS 'spreadsheet';

CREATE TABLE "spreadsheet_heads" (
    "page_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "head_seq" BIGINT NOT NULL DEFAULT 0,
    "engine_version" TEXT NOT NULL,
    "hot_snapshot" BYTEA NOT NULL,
    "hot_snapshot_seq" BIGINT NOT NULL DEFAULT 0,
    "snapshot_version_id" UUID,
    "snapshot_seq" BIGINT NOT NULL DEFAULT 0,
    "batches_since_snapshot" INTEGER NOT NULL DEFAULT 0,
    "sheet_names" TEXT[],
    "filters" JSONB NOT NULL DEFAULT '{}',
    "last_op_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spreadsheet_heads_pkey" PRIMARY KEY ("page_id")
);

CREATE TABLE "spreadsheet_op_batches" (
    "id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "base_seq" BIGINT NOT NULL,
    "client_op_id" TEXT NOT NULL,
    "actor_type" "KnowledgeAuthorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "agent_id" UUID,
    "run_id" UUID,
    "agent_credential_id" UUID,
    "engine_version" TEXT NOT NULL,
    "diffs" BYTEA NOT NULL,
    "structural_kind" TEXT,
    "sheet_indexes" INTEGER[],
    "cell_count" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spreadsheet_op_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spreadsheet_heads_org_last_op_idx" ON "spreadsheet_heads"("organization_id", "last_op_at");

-- The page-monotonic order, and the idempotency key a replayed batch lands on.
CREATE UNIQUE INDEX "spreadsheet_op_batches_page_seq_key" ON "spreadsheet_op_batches"("page_id", "seq");
CREATE UNIQUE INDEX "spreadsheet_op_batches_page_actor_client_key" ON "spreadsheet_op_batches"("page_id", "actor_id", "client_op_id");
CREATE INDEX "spreadsheet_op_batches_page_created_idx" ON "spreadsheet_op_batches"("page_id", "created_at");

ALTER TABLE "spreadsheet_heads" ADD CONSTRAINT "spreadsheet_heads_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spreadsheet_op_batches" ADD CONSTRAINT "spreadsheet_op_batches_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "knowledge_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
