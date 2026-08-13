-- Live document streaming: one session per `kb_document_compose` tool call,
-- plus the coalesced durable lane that backs reconnect/late-join bootstrap.

CREATE TYPE "RunDocumentSessionStatus" AS ENUM (
  'streaming',
  'saving',
  'saved',
  'failed',
  'cancelled',
  'superseded'
);

CREATE TABLE "run_document_sessions" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "tool_call_id" TEXT NOT NULL,
  "status" "RunDocumentSessionStatus" NOT NULL DEFAULT 'streaming',
  "error_reason" TEXT,
  "title" TEXT,
  "space_id" UUID,
  "parent_page_id" UUID,
  "override_space_id" UUID,
  "override_parent_page_id" UUID,
  "page_id" UUID,
  "attachment_id" UUID,
  "version_number" INTEGER,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "chars" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3),

  CONSTRAINT "run_document_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_document_sessions_identity_key"
  ON "run_document_sessions" ("run_id", "invocation_id", "tool_call_id");

CREATE INDEX "run_document_sessions_thread_id_created_at_idx"
  ON "run_document_sessions" ("thread_id", "created_at");

CREATE INDEX "run_document_sessions_run_id_idx"
  ON "run_document_sessions" ("run_id");

ALTER TABLE "run_document_sessions"
  ADD CONSTRAINT "run_document_sessions_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "run_document_chunks" (
  "id" BIGSERIAL NOT NULL,
  "session_id" UUID NOT NULL,
  "offset" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "run_document_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "run_document_chunks_session_id_id_idx"
  ON "run_document_chunks" ("session_id", "id");

ALTER TABLE "run_document_chunks"
  ADD CONSTRAINT "run_document_chunks_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "run_document_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
