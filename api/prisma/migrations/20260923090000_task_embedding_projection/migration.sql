-- A semantic projection over canonical ticket prose. The source remains on
-- tasks; this table carries only the current source hash and vector.
CREATE TABLE "task_embeddings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_id" UUID NOT NULL,
  "content_hash" TEXT NOT NULL,
  "embedding" vector(1024),
  "embedding_model" TEXT,
  "dims" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "task_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_embeddings_task_id_key" UNIQUE ("task_id"),
  CONSTRAINT "task_embeddings_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "task_embeddings_model_dims_idx"
  ON "task_embeddings"("embedding_model", "dims");

CREATE INDEX "task_embeddings_status_idx"
  ON "task_embeddings"("status");

CREATE INDEX "task_embeddings_vector_hnsw_idx"
  ON "task_embeddings" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;

-- The deterministic full-text arm covers ticket prose without a second copy.
CREATE INDEX "tasks_search_document_gin_idx"
  ON "tasks" USING gin (
    to_tsvector(
      'english',
      coalesce("title", '') || ' ' || coalesce("purpose", '') || ' ' || coalesce("detail", '')
    )
  );
