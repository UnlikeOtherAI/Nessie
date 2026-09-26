-- System teams live under the organisation's channel-root project.
--
-- The hidden `system_managed` teams every person's Personal Assistant DM,
-- global-agent home DMs and external-agent DMs hang from were created under
-- the project of whichever user team happened to seed them first. Deleting
-- that project soft-deleted every one of those DMs with it (`deleteProject`
-- stamps every channel of the project), and nothing healed them. The root
-- project is the container no person can delete, and the app now creates
-- system teams there (`ensureSystemTeam`); this moves the existing ones and
-- restores the DMs a deletion took.
--
-- During a blue-green swap the previous release keeps serving while this runs
-- and can still create a system team under a seed project or a channel root.
-- Block those writes for the few milliseconds this takes rather than racing
-- them; the app's ensure paths move a straggler on its next bootstrap anyway.
LOCK TABLE "projects", "teams", "channels" IN SHARE ROW EXCLUSIVE MODE;

-- 1. A root project + its own team for any organisation still lacking one,
--    exactly as 20260914120000 backfilled them (idempotent).
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

INSERT INTO "teams" ("id", "name", "project_id", "system_managed", "created_at", "updated_at")
SELECT gen_random_uuid(), 'Standalone channels', p."id", true, now(), now()
FROM "projects" p
WHERE p."channel_root" = true
  AND NOT EXISTS (
    SELECT 1 FROM "teams" t
    WHERE t."project_id" = p."id" AND t."system_managed" = true AND t."name" = 'Standalone channels'
  );

-- 2. Every system-managed team hanging from a non-root project moves to its
--    organisation's (oldest) root project.
WITH roots AS (
  SELECT DISTINCT ON (p."organization_id") p."organization_id", p."id"
  FROM "projects" p
  WHERE p."channel_root" = true
  ORDER BY p."organization_id", p."created_at" ASC
)
UPDATE "teams" t
SET "project_id" = roots."id", "updated_at" = now()
FROM "projects" seed
JOIN roots ON roots."organization_id" = seed."organization_id"
WHERE t."project_id" = seed."id"
  AND t."system_managed" = true
  AND seed."channel_root" = false;

-- 3. Their channels follow their team.
UPDATE "channels" c
SET "project_id" = t."project_id", "updated_at" = now()
FROM "teams" t
WHERE c."team_id" = t."id"
  AND t."system_managed" = true
  AND c."project_id" <> t."project_id";

-- 4. A system DM a project deletion took with it comes back. Nothing legitimate
--    deletes one (`canModifyChannel` refuses every system channel), so a
--    deletion stamp on a system channel is that collateral and nothing else.
UPDATE "channels" c
SET "deleted_at" = NULL, "archived_at" = NULL, "updated_at" = now()
FROM "teams" t
WHERE c."team_id" = t."id"
  AND t."system_managed" = true
  AND c."system_channel_type" IS NOT NULL
  AND c."deleted_at" IS NOT NULL;
