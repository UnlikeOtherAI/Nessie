ALTER TABLE thoughts
ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS thought_recalls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thought_id UUID NOT NULL REFERENCES thoughts(id),
  session_id TEXT,
  channel_id UUID,
  query_text TEXT NOT NULL,
  query_embedding vector(1536),
  similarity FLOAT,
  rank_position INT NOT NULL,
  retrieval_mode TEXT NOT NULL DEFAULT 'hybrid',
  was_injected BOOLEAN NOT NULL DEFAULT false,
  was_referenced BOOLEAN NOT NULL DEFAULT false,
  user_signal TEXT CHECK (user_signal IN ('helpful', 'irrelevant', 'harmful')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thought_recalls_thought_id_idx
  ON thought_recalls(thought_id);

CREATE INDEX IF NOT EXISTS thought_recalls_session_idx
  ON thought_recalls(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS thought_recalls_created_at_idx
  ON thought_recalls(created_at DESC);

CREATE OR REPLACE FUNCTION scoped_thought_candidates(
  match_org_id uuid,
  match_user_id text
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
  embedding vector(1536),
  search_vector tsvector,
  last_accessed_at timestamptz,
  access_count int
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
    t.embedding,
    t.search_vector,
    t.last_accessed_at,
    t.access_count
  FROM thoughts t
  WHERE t.organization_id = match_org_id
    AND t.deleted_at IS NULL
    AND (
      (t.visibility = 'private' AND t.owner_id = match_user_id)
      OR (t.visibility = 'channel' AND EXISTS (
        SELECT 1
        FROM channel_members cm
        WHERE cm.channel_id = t.channel_id
          AND cm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'team' AND EXISTS (
        SELECT 1
        FROM team_members tm
        WHERE tm.team_id = t.team_id
          AND tm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'project' AND EXISTS (
        SELECT 1
        FROM project_members pm
        WHERE pm.project_id = t.project_id
          AND pm.user_id::text = match_user_id
      ))
      OR (t.visibility = 'organization' AND EXISTS (
        SELECT 1
        FROM organization_members om
        WHERE om.organization_id = t.organization_id
          AND om.user_id::text = match_user_id
      ))
    );
$$;

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
    t.owner_type,
    t.organization_id,
    t.project_id,
    t.team_id,
    t.channel_id,
    t.thread_id,
    t.visibility,
    t.sensitivity_tier,
    t.importance,
    t.metadata,
    t.created_at,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM scoped_thought_candidates(match_org_id, match_user_id) AS t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC, t.created_at DESC
  LIMIT match_limit;
$$;

CREATE OR REPLACE FUNCTION match_thoughts_lexical(
  query_text text,
  match_org_id uuid,
  match_user_id text,
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
  WITH search_query AS (
    SELECT websearch_to_tsquery('english', query_text) AS ts_query
  ),
  lexical_candidates AS (
    SELECT
      t.id,
      t.content,
      t.content_hash,
      t.owner_id,
      t.owner_type,
      t.organization_id,
      t.project_id,
      t.team_id,
      t.channel_id,
      t.thread_id,
      t.visibility,
      t.sensitivity_tier,
      t.importance,
      t.metadata,
      t.created_at,
      ts_rank_cd(t.search_vector, sq.ts_query, 32) AS similarity
    FROM scoped_thought_candidates(match_org_id, match_user_id) AS t
    CROSS JOIN search_query sq
    WHERE numnode(sq.ts_query) > 0
      AND t.search_vector @@ sq.ts_query
    ORDER BY similarity DESC, t.created_at DESC
    LIMIT GREATEST(match_limit * 5, 25)
  )
  SELECT
    id,
    content,
    content_hash,
    owner_id,
    owner_type,
    organization_id,
    project_id,
    team_id,
    channel_id,
    thread_id,
    visibility,
    sensitivity_tier,
    importance,
    metadata,
    created_at,
    similarity
  FROM lexical_candidates
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_limit;
$$;

CREATE OR REPLACE FUNCTION match_thoughts_hybrid(
  query_embedding vector(1536),
  query_text text,
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
  WITH accessible_thoughts AS (
    SELECT *
    FROM scoped_thought_candidates(match_org_id, match_user_id)
  ),
  search_query AS (
    SELECT websearch_to_tsquery('english', query_text) AS ts_query
  ),
  semantic_candidates AS (
    SELECT
      t.id,
      t.content,
      t.content_hash,
      t.owner_id,
      t.owner_type,
      t.organization_id,
      t.project_id,
      t.team_id,
      t.channel_id,
      t.thread_id,
      t.visibility,
      t.sensitivity_tier,
      t.importance,
      t.metadata,
      t.created_at,
      t.last_accessed_at,
      1 - (t.embedding <=> query_embedding) AS semantic_similarity
    FROM accessible_thoughts t
    WHERE t.embedding IS NOT NULL
      AND 1 - (t.embedding <=> query_embedding) > match_threshold
    ORDER BY semantic_similarity DESC, t.created_at DESC
    LIMIT GREATEST(match_limit * 5, 25)
  ),
  semantic_ranked AS (
    SELECT
      sc.*,
      ROW_NUMBER() OVER (ORDER BY sc.semantic_similarity DESC, sc.created_at DESC) AS semantic_rank
    FROM semantic_candidates sc
  ),
  lexical_candidates AS (
    SELECT
      t.id,
      t.content,
      t.content_hash,
      t.owner_id,
      t.owner_type,
      t.organization_id,
      t.project_id,
      t.team_id,
      t.channel_id,
      t.thread_id,
      t.visibility,
      t.sensitivity_tier,
      t.importance,
      t.metadata,
      t.created_at,
      t.last_accessed_at,
      ts_rank_cd(t.search_vector, sq.ts_query, 32) AS lexical_similarity
    FROM accessible_thoughts t
    CROSS JOIN search_query sq
    WHERE numnode(sq.ts_query) > 0
      AND t.search_vector @@ sq.ts_query
    ORDER BY lexical_similarity DESC, t.created_at DESC
    LIMIT GREATEST(match_limit * 5, 25)
  ),
  lexical_ranked AS (
    SELECT
      lc.*,
      ROW_NUMBER() OVER (ORDER BY lc.lexical_similarity DESC, lc.created_at DESC) AS lexical_rank
    FROM lexical_candidates lc
  ),
  fused AS (
    SELECT
      COALESCE(sr.id, lr.id) AS id,
      COALESCE(sr.content, lr.content) AS content,
      COALESCE(sr.content_hash, lr.content_hash) AS content_hash,
      COALESCE(sr.owner_id, lr.owner_id) AS owner_id,
      COALESCE(sr.owner_type, lr.owner_type) AS owner_type,
      COALESCE(sr.organization_id, lr.organization_id) AS organization_id,
      COALESCE(sr.project_id, lr.project_id) AS project_id,
      COALESCE(sr.team_id, lr.team_id) AS team_id,
      COALESCE(sr.channel_id, lr.channel_id) AS channel_id,
      COALESCE(sr.thread_id, lr.thread_id) AS thread_id,
      COALESCE(sr.visibility, lr.visibility) AS visibility,
      COALESCE(sr.sensitivity_tier, lr.sensitivity_tier) AS sensitivity_tier,
      COALESCE(sr.importance, lr.importance) AS importance,
      COALESCE(sr.metadata, lr.metadata) AS metadata,
      COALESCE(sr.created_at, lr.created_at) AS created_at,
      COALESCE(1.0 / (60 + sr.semantic_rank), 0.0)
        + COALESCE(1.0 / (60 + lr.lexical_rank), 0.0) AS rrf_score,
      1.0 / (
        1.0
        + (
          EXTRACT(
            EPOCH FROM (
              now()
              - COALESCE(
                sr.last_accessed_at,
                lr.last_accessed_at,
                sr.created_at,
                lr.created_at
              )
            )
          ) / 86400.0
        ) * 0.01
      ) AS recency_score
    FROM semantic_ranked sr
    FULL OUTER JOIN lexical_ranked lr
      ON sr.id = lr.id
  )
  SELECT
    id,
    content,
    content_hash,
    owner_id,
    owner_type,
    organization_id,
    project_id,
    team_id,
    channel_id,
    thread_id,
    visibility,
    sensitivity_tier,
    importance,
    metadata,
    created_at,
    rrf_score + (recency_score * 0.01) AS similarity
  FROM fused
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_limit;
$$;
