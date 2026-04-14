DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'ThoughtAudienceType'
  ) THEN
    CREATE TYPE "ThoughtAudienceType" AS ENUM (
      'user',
      'channel',
      'team',
      'project',
      'organization'
    );
  END IF;
END
$$;

ALTER TABLE "thoughts"
ADD COLUMN IF NOT EXISTS "audience_type" "ThoughtAudienceType",
ADD COLUMN IF NOT EXISTS "audience_id" UUID,
ADD COLUMN IF NOT EXISTS "user_id" UUID;

ALTER TABLE "thought_recalls"
ADD COLUMN IF NOT EXISTS "requester_user_id" UUID,
ADD COLUMN IF NOT EXISTS "output_audience_type" "ThoughtAudienceType",
ADD COLUMN IF NOT EXISTS "output_audience_id" UUID;

CREATE INDEX IF NOT EXISTS "thoughts_organization_id_audience_type_audience_id_created_at_idx"
  ON "thoughts"("organization_id", "audience_type", "audience_id", "created_at");

CREATE INDEX IF NOT EXISTS "thoughts_user_id_created_at_idx"
  ON "thoughts"("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "thought_recalls_requester_user_id_created_at_idx"
  ON "thought_recalls"("requester_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "thought_recalls_output_audience_type_output_audience_id_created_at_idx"
  ON "thought_recalls"("output_audience_type", "output_audience_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION safe_uuid(value text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;

  IF value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN value::uuid;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION resolve_thought_audience_type(
  stored_audience_type "ThoughtAudienceType",
  stored_visibility "ThoughtVisibility",
  stored_owner_type "ThoughtOwnerType",
  stored_owner_id text,
  stored_user_id uuid
)
RETURNS "ThoughtAudienceType"
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF stored_audience_type IS NOT NULL THEN
    RETURN stored_audience_type;
  END IF;

  CASE stored_visibility
    WHEN 'private' THEN
      IF stored_user_id IS NOT NULL OR (
        stored_owner_type = 'user'
        AND safe_uuid(stored_owner_id) IS NOT NULL
      ) THEN
        RETURN 'user'::"ThoughtAudienceType";
      END IF;
      RETURN NULL;
    WHEN 'channel' THEN
      RETURN 'channel'::"ThoughtAudienceType";
    WHEN 'team' THEN
      RETURN 'team'::"ThoughtAudienceType";
    WHEN 'project' THEN
      RETURN 'project'::"ThoughtAudienceType";
    WHEN 'organization' THEN
      RETURN 'organization'::"ThoughtAudienceType";
    ELSE
      RETURN NULL;
  END CASE;
END
$$;

CREATE OR REPLACE FUNCTION resolve_thought_audience_id(
  stored_audience_id uuid,
  resolved_audience_type "ThoughtAudienceType",
  stored_organization_id uuid,
  stored_project_id uuid,
  stored_team_id uuid,
  stored_channel_id uuid,
  stored_user_id uuid,
  stored_owner_type "ThoughtOwnerType",
  stored_owner_id text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF stored_audience_id IS NOT NULL THEN
    RETURN stored_audience_id;
  END IF;

  CASE resolved_audience_type
    WHEN 'user' THEN
      RETURN COALESCE(
        stored_user_id,
        CASE
          WHEN stored_owner_type = 'user' THEN safe_uuid(stored_owner_id)
          ELSE NULL
        END
      );
    WHEN 'channel' THEN
      RETURN stored_channel_id;
    WHEN 'team' THEN
      RETURN stored_team_id;
    WHEN 'project' THEN
      RETURN stored_project_id;
    WHEN 'organization' THEN
      RETURN stored_organization_id;
    ELSE
      RETURN NULL;
  END CASE;
END
$$;

UPDATE "thoughts"
SET "user_id" = COALESCE("user_id", safe_uuid("owner_id"))
WHERE "owner_type" = 'user'
  AND "user_id" IS NULL;

WITH resolved AS (
  SELECT
    t.id,
    resolve_thought_audience_type(
      t.audience_type,
      t.visibility,
      t.owner_type,
      t.owner_id,
      t.user_id
    ) AS resolved_audience_type
  FROM "thoughts" AS t
)
UPDATE "thoughts" AS t
SET
  "audience_type" = COALESCE(t."audience_type", resolved.resolved_audience_type),
  "audience_id" = COALESCE(
    t."audience_id",
    resolve_thought_audience_id(
      t."audience_id",
      resolved.resolved_audience_type,
      t."organization_id",
      t."project_id",
      t."team_id",
      t."channel_id",
      t."user_id",
      t."owner_type",
      t."owner_id"
    )
  )
FROM resolved
WHERE t.id = resolved.id;

CREATE OR REPLACE FUNCTION thought_requester_has_access(
  requester_user_id uuid,
  audience_type "ThoughtAudienceType",
  audience_id uuid,
  organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF requester_user_id IS NULL OR audience_type IS NULL OR audience_id IS NULL THEN
    RETURN false;
  END IF;

  CASE audience_type
    WHEN 'user' THEN
      RETURN audience_id = requester_user_id;
    WHEN 'channel' THEN
      RETURN EXISTS (
        SELECT 1
        FROM "channel_members" AS cm
        WHERE cm."channel_id" = audience_id
          AND cm."user_id" = requester_user_id
      );
    WHEN 'team' THEN
      RETURN EXISTS (
        SELECT 1
        FROM "team_members" AS tm
        WHERE tm."team_id" = audience_id
          AND tm."user_id" = requester_user_id
      );
    WHEN 'project' THEN
      RETURN EXISTS (
        SELECT 1
        FROM "project_members" AS pm
        WHERE pm."project_id" = audience_id
          AND pm."user_id" = requester_user_id
      );
    WHEN 'organization' THEN
      RETURN audience_id = organization_id
        AND EXISTS (
          SELECT 1
          FROM "organization_members" AS om
          WHERE om."organization_id" = organization_id
            AND om."user_id" = requester_user_id
        );
    ELSE
      RETURN false;
  END CASE;
END
$$;

CREATE OR REPLACE FUNCTION channel_audience_within_team(
  output_channel_id uuid,
  target_team_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF output_channel_id IS NULL OR target_team_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM "channels" AS c
    WHERE c."id" = output_channel_id
      AND c."team_id" = target_team_id
      AND NOT EXISTS (
        SELECT 1
        FROM "channel_members" AS cm
        WHERE cm."channel_id" = c."id"
          AND NOT EXISTS (
            SELECT 1
            FROM "team_members" AS tm
            WHERE tm."team_id" = c."team_id"
              AND tm."user_id" = cm."user_id"
          )
      )
  );
END
$$;

CREATE OR REPLACE FUNCTION channel_audience_within_project(
  output_channel_id uuid,
  target_project_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF output_channel_id IS NULL OR target_project_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM "channels" AS c
    JOIN "teams" AS t
      ON t."id" = c."team_id"
    WHERE c."id" = output_channel_id
      AND t."project_id" = target_project_id
      AND NOT EXISTS (
        SELECT 1
        FROM "channel_members" AS cm
        WHERE cm."channel_id" = c."id"
          AND NOT EXISTS (
            SELECT 1
            FROM "project_members" AS pm
            WHERE pm."project_id" = t."project_id"
              AND pm."user_id" = cm."user_id"
          )
      )
  );
END
$$;

CREATE OR REPLACE FUNCTION team_audience_within_project(
  output_team_id uuid,
  target_project_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF output_team_id IS NULL OR target_project_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM "teams" AS t
    WHERE t."id" = output_team_id
      AND t."project_id" = target_project_id
      AND NOT EXISTS (
        SELECT 1
        FROM "team_members" AS tm
        WHERE tm."team_id" = t."id"
          AND NOT EXISTS (
            SELECT 1
            FROM "project_members" AS pm
            WHERE pm."project_id" = t."project_id"
              AND pm."user_id" = tm."user_id"
          )
      )
  );
END
$$;

CREATE OR REPLACE FUNCTION thought_audience_compatible_with_output(
  memory_audience_type "ThoughtAudienceType",
  memory_audience_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid,
  organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF memory_audience_type IS NULL
    OR memory_audience_id IS NULL
    OR output_audience_type IS NULL
    OR output_audience_id IS NULL THEN
    RETURN false;
  END IF;

  IF output_audience_type = 'user'::"ThoughtAudienceType" THEN
    RETURN true;
  END IF;

  CASE output_audience_type
    WHEN 'channel' THEN
      CASE memory_audience_type
        WHEN 'organization' THEN
          RETURN memory_audience_id = organization_id;
        WHEN 'project' THEN
          RETURN channel_audience_within_project(output_audience_id, memory_audience_id);
        WHEN 'team' THEN
          RETURN channel_audience_within_team(output_audience_id, memory_audience_id);
        WHEN 'channel' THEN
          RETURN memory_audience_id = output_audience_id;
        ELSE
          RETURN false;
      END CASE;
    WHEN 'team' THEN
      CASE memory_audience_type
        WHEN 'organization' THEN
          RETURN memory_audience_id = organization_id;
        WHEN 'project' THEN
          RETURN team_audience_within_project(output_audience_id, memory_audience_id);
        WHEN 'team' THEN
          RETURN memory_audience_id = output_audience_id;
        ELSE
          RETURN false;
      END CASE;
    WHEN 'project' THEN
      RETURN (
        memory_audience_type = 'organization'::"ThoughtAudienceType"
        AND memory_audience_id = organization_id
      ) OR (
        memory_audience_type = 'project'::"ThoughtAudienceType"
        AND memory_audience_id = output_audience_id
      );
    WHEN 'organization' THEN
      RETURN memory_audience_type = 'organization'::"ThoughtAudienceType"
        AND memory_audience_id = organization_id
        AND output_audience_id = organization_id;
    ELSE
      RETURN false;
  END CASE;
END
$$;

DROP FUNCTION IF EXISTS scoped_thought_candidates(uuid, text);
DROP FUNCTION IF EXISTS match_thoughts_scoped(vector, uuid, text, double precision, integer);
DROP FUNCTION IF EXISTS match_thoughts_lexical(text, uuid, text, integer);
DROP FUNCTION IF EXISTS match_thoughts_hybrid(vector, text, uuid, text, double precision, integer);

CREATE OR REPLACE FUNCTION scoped_thought_candidates(
  match_org_id uuid,
  match_user_id uuid,
  output_audience_type "ThoughtAudienceType",
  output_audience_id uuid
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
LANGUAGE sql
STABLE
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
  FROM "thoughts" AS t
  CROSS JOIN LATERAL (
    SELECT
      resolve_thought_audience_type(
        t.audience_type,
        t.visibility,
        t.owner_type,
        t.owner_id,
        t.user_id
      ) AS audience_type,
      resolve_thought_audience_id(
        t.audience_id,
        resolve_thought_audience_type(
          t.audience_type,
          t.visibility,
          t.owner_type,
          t.owner_id,
          t.user_id
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
  WHERE t.organization_id = match_org_id
    AND t.deleted_at IS NULL
    AND resolved.audience_type IS NOT NULL
    AND resolved.audience_id IS NOT NULL
    AND thought_requester_has_access(
      match_user_id,
      output_audience_type,
      output_audience_id,
      t.organization_id
    )
    AND thought_requester_has_access(
      match_user_id,
      resolved.audience_type,
      resolved.audience_id,
      t.organization_id
    )
    AND thought_audience_compatible_with_output(
      resolved.audience_type,
      resolved.audience_id,
      output_audience_type,
      output_audience_id,
      t.organization_id
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
    1 - (t.embedding <=> query_embedding) AS similarity
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
      ts_rank_cd(t.search_vector, sq.ts_query, 32) AS similarity
    FROM scoped_thought_candidates(
      match_org_id,
      match_user_id,
      output_audience_type,
      output_audience_id
    ) AS t
    CROSS JOIN search_query AS sq
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
