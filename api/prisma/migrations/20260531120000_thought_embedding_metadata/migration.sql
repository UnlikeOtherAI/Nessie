ALTER TABLE "thoughts"
ADD COLUMN IF NOT EXISTS "embedding_model" TEXT,
ADD COLUMN IF NOT EXISTS "dims" INTEGER;

-- Backfill embedding metadata only for rows that actually have an embedding.
-- Embedding-less thoughts (lexical-only / failed embedding) keep NULL model+dims
-- so the metadata always describes a real vector (Phase D fuses on embeddingModel).
UPDATE "thoughts"
SET
  "embedding_model" = 'text-embedding-3-small',
  "dims" = 1536
WHERE "embedding" IS NOT NULL
  AND ("embedding_model" IS NULL OR "dims" IS NULL);
