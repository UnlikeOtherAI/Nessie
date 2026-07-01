CREATE TABLE IF NOT EXISTS knowledge_page_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES knowledge_page_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  token_count INTEGER,
  embedding vector(1536),
  embedding_model TEXT,
  dims INTEGER,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(content, ''))
  ) STORED,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  team_id UUID,
  channel_id UUID,
  thread_id UUID,
  user_id UUID,
  visibility "ThoughtVisibility" NOT NULL DEFAULT 'project',
  sensitivity_tier "SensitivityTier" NOT NULL DEFAULT 'normal',
  private_to_agent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_page_chunks_version_chunk_key
  ON knowledge_page_chunks(version_id, chunk_index);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_page_version_idx
  ON knowledge_page_chunks(page_id, version_id);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_org_project_updated_id_idx
  ON knowledge_page_chunks(organization_id, project_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_org_visibility_updated_idx
  ON knowledge_page_chunks(organization_id, visibility, updated_at);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_org_sensitivity_idx
  ON knowledge_page_chunks(organization_id, sensitivity_tier);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_private_to_agent_id_idx
  ON knowledge_page_chunks(private_to_agent_id);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_embedding_idx
  ON knowledge_page_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_search_vector_idx
  ON knowledge_page_chunks USING GIN (search_vector);

CREATE INDEX IF NOT EXISTS knowledge_page_chunks_content_hash_idx
  ON knowledge_page_chunks(content_hash);

