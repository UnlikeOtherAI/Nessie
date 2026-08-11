-- Re-type every embedding column from vector(1536) to vector(1024).
--
-- Embeddings are moving off OpenAI's `text-embedding-3-small` (1536) onto
-- `jina-embeddings-v3` (1024), reached through Ledger's `/v1/jina` adapter,
-- because the deployment's chat provider (DeepSeek) serves no embeddings
-- endpoint at all — Ledger answers `embeddings is not allowed for deepseek`,
-- and every memory search and knowledge embed has been failing on it.
--
-- The width is not negotiable in either direction: Jina v3's Matryoshka
-- `dimensions` parameter only truncates downward from 1024, so it can never
-- fill a 1536-wide column, and pgvector will not compare vectors of different
-- widths. The single source of truth for the number is `EMBEDDING_DIMENSIONS`
-- in `packages/schemas/src/embedding.ts`; this migration and that constant move
-- together.
--
-- Existing vectors are DISCARDED, not converted. A 1536-dim OpenAI vector has
-- no meaningful 1024-dim equivalent — truncating it would silently poison every
-- future cosine comparison with values that are neither one model's output nor
-- the other's. Nulling them makes the rows re-embed naturally: memory capture
-- writes a fresh vector on the next write, `knowledge.embed` refills any chunk
-- whose `embedding IS NULL`, and recall degrades to the lexical channel until
-- then. `embedding_model` / `dims` are cleared with the vector so no row claims
-- provenance for bytes that are gone.
--
-- The HNSW index has to go before the type change (pgvector refuses to re-type
-- an indexed vector column) and is recreated afterwards with identical options.
-- Rebuilding is instant here because every embedding is NULL at that point.
--
-- The three `match_thoughts_*` functions declare `query_embedding vector(1536)`
-- but do NOT need recreating: PostgreSQL discards the typmod on function
-- parameters, so `pg_get_function_arguments` reports plain `vector` and the
-- parameter accepts any width. Their bodies compare the argument against
-- `thoughts.embedding`, which pgvector checks at runtime — after this migration
-- both sides are 1024.

DROP INDEX IF EXISTS knowledge_page_chunks_embedding_idx;

UPDATE thoughts
   SET embedding = NULL, embedding_model = NULL, dims = NULL
 WHERE embedding IS NOT NULL;

UPDATE thought_recalls
   SET query_embedding = NULL
 WHERE query_embedding IS NOT NULL;

UPDATE knowledge_page_chunks
   SET embedding = NULL, embedding_model = NULL, dims = NULL
 WHERE embedding IS NOT NULL;

ALTER TABLE thoughts
  ALTER COLUMN embedding TYPE vector(1024);

ALTER TABLE thought_recalls
  ALTER COLUMN query_embedding TYPE vector(1024);

ALTER TABLE knowledge_page_chunks
  ALTER COLUMN embedding TYPE vector(1024);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_embedding_idx
  ON knowledge_page_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
