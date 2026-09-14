-- Every organisation has a shared-channel root holding #general and #random.
--
-- New organisations get both in the transaction that creates them
-- (`ensureSharedChannelRootInTransaction`). This backfills existing ones
-- without resurrecting anything a person deleted: deleting archives, so an
-- archived row still counts as "this root has had channels". Only a root that
-- has never held a standard channel is seeded.

-- 1. A root project + system-managed team for every organisation lacking one.
WITH missing AS (
  SELECT o."id" AS organization_id, gen_random_uuid() AS project_id
  FROM "organizations" o
  WHERE NOT EXISTS (
    SELECT 1 FROM "projects" p
    WHERE p."organization_id" = o."id" AND p."channel_root" = true
  )
),
new_projects AS (
  INSERT INTO "projects" ("id", "name", "organization_id", "channel_root", "created_at", "updated_at")
  SELECT project_id, 'Standalone channels', organization_id, true, now(), now()
  FROM missing
  RETURNING "id"
)
INSERT INTO "teams" ("id", "name", "project_id", "system_managed", "created_at", "updated_at")
SELECT gen_random_uuid(), 'Standalone channels', "id", true, now(), now()
FROM new_projects;

-- A legacy root (the local bootstrap project was promoted in place) may have
-- no system-managed team; the app resolves the root through that team.
INSERT INTO "teams" ("id", "name", "project_id", "system_managed", "created_at", "updated_at")
SELECT gen_random_uuid(), 'Standalone channels', p."id", true, now(), now()
FROM "projects" p
WHERE p."channel_root" = true
  AND NOT EXISTS (
    SELECT 1 FROM "teams" t WHERE t."project_id" = p."id" AND t."system_managed" = true
  );

-- 2. #general and #random in every root that has never held a standard channel.
INSERT INTO "channels" (
  "id", "label", "slug", "type", "organization_id", "project_id", "team_id",
  "visibility", "created_at", "updated_at"
)
SELECT gen_random_uuid(), names.name, names.name, 'standard', p."organization_id",
  p."id", t."id", 'public', now() + names.position * interval '1 millisecond', now()
FROM "projects" p
JOIN LATERAL (
  SELECT t."id" FROM "teams" t
  WHERE t."project_id" = p."id" AND t."system_managed" = true
  ORDER BY t."created_at" ASC
  LIMIT 1
) t ON true
CROSS JOIN (VALUES ('general', 0), ('random', 1)) AS names(name, position)
WHERE p."channel_root" = true
  AND NOT EXISTS (
    SELECT 1 FROM "channels" c
    WHERE c."project_id" = p."id" AND c."type" = 'standard'
  );

-- 3. A channel's name is its slug. Seeds wrote a capitalised "General" label
-- beside the "general" slug; every other write already normalises.
UPDATE "channels"
SET "label" = "slug", "updated_at" = now()
WHERE "type" = 'standard'
  AND "slug" IS NOT NULL
  AND "label" <> "slug";
