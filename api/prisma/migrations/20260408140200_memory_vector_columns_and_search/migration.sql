-- Vector embedding column
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Precomputed tsvector for full-text search
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, ''))
  ) STORED;

-- HNSW index for vector similarity
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
  ON thoughts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_thoughts_search_vector
  ON thoughts USING GIN (search_vector);

-- GIN index on metadata JSONB
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
  ON thoughts USING GIN (metadata);

-- Scoped semantic search function
CREATE OR REPLACE FUNCTION match_thoughts_scoped(
  query_embedding vector(1536),
  match_org_id uuid,
  match_user_id text,
  match_threshold float DEFAULT 0.3,
  match_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  content text,
  content_hash text,
  owner_id text,
  owner_type text,
  organization_id uuid,
  project_id uuid,
  team_id uuid,
  channel_id uuid,
  thread_id uuid,
  visibility text,
  sensitivity_tier text,
  importance float8,
  metadata jsonb,
  created_at timestamptz,
  similarity float8
)
LANGUAGE sql STABLE
AS $$
  SELECT
    t.id,
    t.content,
    t.content_hash,
    t.owner_id,
    t.owner_type::text,
    t.organization_id,
    t.project_id,
    t.team_id,
    t.channel_id,
    t.thread_id,
    t.visibility::text,
    t.sensitivity_tier::text,
    t.importance,
    t.metadata,
    t.created_at,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM thoughts t
  WHERE t.organization_id = match_org_id
    AND t.deleted_at IS NULL
    AND t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (
      (t.visibility = 'private' AND t.owner_id = match_user_id)
      OR (t.visibility = 'channel' AND EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = t.channel_id AND cm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'team' AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = t.team_id AND tm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'project' AND EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = t.project_id AND pm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'organization' AND EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = t.organization_id AND om.user_id::text = match_user_id
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_limit;
$$;
