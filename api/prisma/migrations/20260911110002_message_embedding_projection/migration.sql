-- A semantic projection over canonical messages. Content stays exclusively on
-- messages; this table contains only the current source hash and its vector.
CREATE TABLE "message_embeddings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id" UUID NOT NULL,
  "content_hash" TEXT NOT NULL,
  "embedding" vector(1024),
  "embedding_model" TEXT,
  "dims" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "message_embeddings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_embeddings_message_id_key" UNIQUE ("message_id"),
  CONSTRAINT "message_embeddings_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "message_embeddings_model_dims_idx"
  ON "message_embeddings"("embedding_model", "dims");

CREATE INDEX "message_embeddings_status_idx"
  ON "message_embeddings"("status");

CREATE INDEX "message_embeddings_vector_hnsw_idx"
  ON "message_embeddings" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
