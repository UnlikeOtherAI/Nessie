DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ThoughtMemoryType'
  ) THEN
    CREATE TYPE "ThoughtMemoryType" AS ENUM (
      'episodic',
      'semantic',
      'procedural'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ThoughtMemoryCategory'
  ) THEN
    CREATE TYPE "ThoughtMemoryCategory" AS ENUM (
      'intent',
      'reason',
      'constraint',
      'preference',
      'fact'
    );
  END IF;
END
$$;

ALTER TABLE "thoughts"
ADD COLUMN IF NOT EXISTS "memory_type" "ThoughtMemoryType" NOT NULL DEFAULT 'semantic',
ADD COLUMN IF NOT EXISTS "memory_category" "ThoughtMemoryCategory" NOT NULL DEFAULT 'fact';

CREATE INDEX IF NOT EXISTS "thoughts_organization_id_memory_type_memory_category_created_at_idx"
  ON "thoughts" ("organization_id", "memory_type", "memory_category", "created_at");

-- Keep outcome weighting small enough to preserve RRF/recency as the primary
-- signal while making successful reasoning outrank otherwise-similar memories.
CREATE OR REPLACE FUNCTION thought_outcome_score(input_thought_id uuid)
RETURNS float8
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    MAX(
      CASE tr."outcome"
        WHEN 'successful'::"OutcomeStatus" THEN 1.0
        WHEN 'partially'::"OutcomeStatus" THEN 0.66
        WHEN 'pending'::"OutcomeStatus" THEN 0.33
        WHEN 'superseded'::"OutcomeStatus" THEN 0.16
        WHEN 'failed'::"OutcomeStatus" THEN 0.0
        ELSE 0.33
      END
    ),
    0.33
  )
  FROM "thought_reasonings" AS tr
  WHERE tr."thought_id" = input_thought_id;
$$;

CREATE OR REPLACE FUNCTION thought_audience_member_ids(
  input_audience_type "ThoughtAudienceType",
  input_audience_id uuid,
  input_organization_id uuid
)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT om."user_id"
  FROM "organization_members" AS om
  WHERE input_audience_type = 'organization'::"ThoughtAudienceType"
    AND input_audience_id = input_organization_id
    AND om."organization_id" = input_organization_id

  UNION

  SELECT pm."user_id"
  FROM "project_members" AS pm
  JOIN "projects" AS p
    ON p."id" = pm."project_id"
  WHERE input_audience_type = 'project'::"ThoughtAudienceType"
    AND pm."project_id" = input_audience_id
    AND p."organization_id" = input_organization_id

  UNION

  SELECT tm."user_id"
  FROM "team_members" AS tm
  JOIN "teams" AS t
    ON t."id" = tm."team_id"
  JOIN "projects" AS p
    ON p."id" = t."project_id"
  WHERE input_audience_type = 'team'::"ThoughtAudienceType"
    AND tm."team_id" = input_audience_id
    AND p."organization_id" = input_organization_id

  UNION

  SELECT cm."user_id"
  FROM "channel_members" AS cm
  JOIN "channels" AS c
    ON c."id" = cm."channel_id"
  WHERE input_audience_type = 'channel'::"ThoughtAudienceType"
    AND cm."channel_id" = input_audience_id
    AND c."organization_id" = input_organization_id

  UNION

  SELECT u."id" AS user_id
  FROM "users" AS u
  WHERE input_audience_type = 'user'::"ThoughtAudienceType"
    AND u."id" = input_audience_id
    AND EXISTS (
      SELECT 1
      FROM "organization_members" AS om
      WHERE om."organization_id" = input_organization_id
        AND om."user_id" = u."id"
    );
$$;

CREATE OR REPLACE FUNCTION thought_audience_is_subset(
  current_audience_type "ThoughtAudienceType",
  current_audience_id uuid,
  source_audience_type "ThoughtAudienceType",
  source_audience_id uuid,
  input_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH current_members AS (
    SELECT user_id
    FROM thought_audience_member_ids(
      current_audience_type,
      current_audience_id,
      input_organization_id
    )
  ),
  source_members AS (
    SELECT user_id
    FROM thought_audience_member_ids(
      source_audience_type,
      source_audience_id,
      input_organization_id
    )
  )
  SELECT EXISTS (SELECT 1 FROM current_members)
    AND NOT EXISTS (
      SELECT 1
      FROM current_members AS current_member
      WHERE NOT EXISTS (
        SELECT 1
        FROM source_members AS source_member
        WHERE source_member.user_id = current_member.user_id
      )
    );
$$;

CREATE OR REPLACE FUNCTION thought_audience_compatible_with_output(
  memory_audience_type "ThoughtAudienceType",
  memory_audience_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid,
  organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  -- A memory is always compatible with its own audience: recall in the exact
  -- same audience must succeed even if member resolution is momentarily empty
  -- (e.g. a channel whose membership rows are not yet populated). This can
  -- never leak — the audiences are identical. Otherwise fall back to the
  -- deny-bias subset check (output's members must all be able to see source).
  SELECT
    (
      output_audience_type = memory_audience_type
      AND output_audience_id = memory_audience_id
    )
    OR thought_audience_is_subset(
      output_audience_type,
      output_audience_id,
      memory_audience_type,
      memory_audience_id,
      organization_id
    );
$$;

CREATE OR REPLACE FUNCTION match_thoughts_scoped(
  query_embedding vector(1536),
  match_org_id uuid,
  match_user_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid,
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
    (1 - (t.embedding <=> query_embedding))
      + (thought_outcome_score(t.id) * 0.005) AS similarity
  FROM scoped_thought_candidates(
    match_org_id,
    match_user_id,
    output_audience_type,
    output_audience_id
  ) AS t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC, t.created_at DESC
  LIMIT match_limit;
$$;

CREATE OR REPLACE FUNCTION match_thoughts_lexical(
  query_text text,
  match_org_id uuid,
  match_user_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid,
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
      ts_rank_cd(t.search_vector, sq.ts_query, 32) AS lexical_similarity
    FROM scoped_thought_candidates(
      match_org_id,
      match_user_id,
      output_audience_type,
      output_audience_id
    ) AS t
    CROSS JOIN search_query AS sq
    WHERE numnode(sq.ts_query) > 0
      AND t.search_vector @@ sq.ts_query
      AND ts_rank_cd(t.search_vector, sq.ts_query, 32) > match_threshold
    ORDER BY lexical_similarity DESC, t.created_at DESC
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
    lexical_similarity + (thought_outcome_score(id) * 0.005) AS similarity
  FROM lexical_candidates
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_limit;
$$;

CREATE OR REPLACE FUNCTION match_thoughts_hybrid(
  query_embedding vector(1536),
  query_text text,
  match_org_id uuid,
  match_user_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid,
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
  WITH accessible_thoughts AS (
    SELECT *
    FROM scoped_thought_candidates(
      match_org_id,
      match_user_id,
      output_audience_type,
      output_audience_id
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
      thought_outcome_score(t.id) AS outcome_score,
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
      thought_outcome_score(t.id) AS outcome_score,
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
      COALESCE(sr.outcome_score, lr.outcome_score, 0.33) AS outcome_score,
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
    rrf_score
      + (recency_score * 0.01)
      + (outcome_score * 0.005) AS similarity
  FROM fused
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_limit;
$$;

DROP FUNCTION IF EXISTS match_thoughts_in_scopes(
  vector,
  text,
  uuid,
  text[],
  uuid[],
  uuid,
  double precision,
  integer
);

CREATE OR REPLACE FUNCTION match_thoughts_in_scopes(
  query_embedding vector(1536),
  query_text text,
  match_org_id uuid,
  audience_types text[],
  audience_ids uuid[],
  current_audience_type "ThoughtAudienceType",
  current_audience_id uuid,
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
      AND thought_audience_compatible_with_output(
        resolved.audience_type,
        resolved.audience_id,
        current_audience_type,
        current_audience_id,
        t.organization_id
      )
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
      thought_outcome_score(t.id) AS outcome_score,
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
      thought_outcome_score(t.id) AS outcome_score,
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
      COALESCE(sr.outcome_score, lr.outcome_score, 0.33) AS outcome_score,
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
    rrf_score
      + (recency_score * 0.01)
      + (outcome_score * 0.005) AS similarity
  FROM fused
  ORDER BY similarity DESC, created_at DESC
  LIMIT match_limit;
$$;
