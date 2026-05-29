-- Per-agent selective memory.
--
-- 1. `private_to_agent_id` marks a memory as private to a single agent. It is
--    orthogonal to the audience (access) axis: the audience still governs which
--    users/scopes may access the memory, so user-access filtering is unchanged.
-- 2. `match_thoughts_in_scopes` recalls across an explicit set of accessible
--    audiences (channels/teams/projects/org/user) computed in the application
--    layer, plus the per-agent privacy predicate. Eligibility is plain set
--    membership over the caller-supplied scope list.

ALTER TABLE "thoughts" ADD COLUMN IF NOT EXISTS "private_to_agent_id" uuid;

CREATE INDEX IF NOT EXISTS "thoughts_private_to_agent_id_idx"
  ON "thoughts" ("private_to_agent_id");

CREATE OR REPLACE FUNCTION match_thoughts_in_scopes(
  query_embedding vector(1536),
  query_text text,
  match_org_id uuid,
  audience_types text[],
  audience_ids uuid[],
  running_agent_id uuid,
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
LANGUAGE sql
STABLE
AS $$
  WITH scope_set AS (
    SELECT
      s.atype::"ThoughtAudienceType" AS audience_type,
      s.aid AS audience_id
    FROM unnest(audience_types, audience_ids) AS s(atype, aid)
  ),
  accessible_thoughts AS (
    SELECT
      t.id,
      t.content,
      t.content_hash,
      t.owner_id,
      t.owner_type::text AS owner_type,
      t.organization_id,
      t.project_id,
      t.team_id,
      t.channel_id,
      t.thread_id,
      t.visibility::text AS visibility,
      t.sensitivity_tier::text AS sensitivity_tier,
      t.importance,
      t.metadata,
      t.created_at,
      t.embedding,
      t.search_vector,
      t.last_accessed_at
    FROM "thoughts" AS t
    CROSS JOIN LATERAL (
      SELECT
        resolve_thought_audience_type(
          t.audience_type,
          t.visibility,
          t.owner_type,
          t.owner_id,
          t.user_id,
          t.organization_id,
          t.project_id,
          t.team_id,
          t.channel_id
        ) AS audience_type,
        resolve_thought_audience_id(
          t.audience_id,
          resolve_thought_audience_type(
            t.audience_type,
            t.visibility,
            t.owner_type,
            t.owner_id,
            t.user_id,
            t.organization_id,
            t.project_id,
            t.team_id,
            t.channel_id
          ),
          t.organization_id,
          t.project_id,
          t.team_id,
          t.channel_id,
          t.user_id,
          t.owner_type,
          t.owner_id
        ) AS audience_id
    ) AS resolved
    JOIN scope_set AS ss
      ON ss.audience_type = resolved.audience_type
     AND ss.audience_id = resolved.audience_id
    WHERE t.organization_id = match_org_id
      AND t.deleted_at IS NULL
      AND resolved.audience_type IS NOT NULL
      AND resolved.audience_id IS NOT NULL
      AND (
        t.private_to_agent_id IS NULL
        OR t.private_to_agent_id = running_agent_id
      )
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
    FROM accessible_thoughts AS t
    WHERE t.embedding IS NOT NULL
      AND 1 - (t.embedding <=> query_embedding) > match_threshold
    ORDER BY semantic_similarity DESC, t.created_at DESC
    LIMIT GREATEST(match_limit * 5, 25)
  ),
  semantic_ranked AS (
    SELECT
      sc.*,
      ROW_NUMBER() OVER (ORDER BY sc.semantic_similarity DESC, sc.created_at DESC) AS semantic_rank
    FROM semantic_candidates AS sc
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
    FROM accessible_thoughts AS t
    CROSS JOIN search_query AS sq
    WHERE numnode(sq.ts_query) > 0
      AND t.search_vector @@ sq.ts_query
    ORDER BY lexical_similarity DESC, t.created_at DESC
    LIMIT GREATEST(match_limit * 5, 25)
  ),
  lexical_ranked AS (
    SELECT
      lc.*,
      ROW_NUMBER() OVER (ORDER BY lc.lexical_similarity DESC, lc.created_at DESC) AS lexical_rank
    FROM lexical_candidates AS lc
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
    FROM semantic_ranked AS sr
    FULL OUTER JOIN lexical_ranked AS lr
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
