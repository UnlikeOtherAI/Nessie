ALTER TABLE "thoughts"
ADD COLUMN IF NOT EXISTS "embedding_model" TEXT,
ADD COLUMN IF NOT EXISTS "dims" INTEGER;

UPDATE "thoughts"
SET
  "embedding_model" = COALESCE("embedding_model", 'text-embedding-3-small'),
  "dims" = COALESCE("dims", 1536)
WHERE "embedding_model" IS NULL
   OR "dims" IS NULL;
