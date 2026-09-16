-- A dashboard lives in a project.
--
-- It used to have five possible homes — organization, project, team, channel,
-- personal — each with its own nullable scope column, paired by
-- `dashboards_home_scope_check` because a row claiming one home while carrying
-- another's id reads as one audience in the UI and another in an entitlement
-- query. Only the project home ever grew a surface a person could navigate to,
-- so the other four were places a dashboard could be put and then not be found
-- (AGENTS.md -> "Rule zero"). One home removes the pairing problem instead of
-- guarding it.
--
-- Re-homing rule, and why each direction is safe:
--
--   channel      -> the channel's own project. The audience was that channel's
--                   members, who are members of its project.
--   team         -> the team's oldest live project. A team's projects are made
--                   of its members, so the audience narrows or stays.
--   organization -> the organisation's oldest live project. Narrows.
--   personal     -> parked in the same fallback project AND archived. This is
--                   the one direction that would WIDEN an audience: a private
--                   dashboard becoming visible to a project's members is
--                   exactly the leak the CHECK constraint existed to prevent.
--                   Archiving keeps the row and its widgets intact and out of
--                   every list; an administrator can unarchive one deliberately,
--                   which is a decision a person makes, not a migration.
--
-- A dashboard whose organisation has no live project at all cannot satisfy the
-- NOT NULL, and there is no project to show it in either. Those rows are
-- deleted; their widgets, versions and deltas cascade.

-- -- 1. Let go of the pairing before moving anything. ------------------------
-- The constraint pairs `home` with its one permitted scope column, so writing
-- `project_id` onto a row that still says home='channel' violates it mid-flight
-- and the whole migration fails. It has to go before the data moves, not after.
ALTER TABLE "dashboards" DROP CONSTRAINT IF EXISTS "dashboards_home_scope_check";

-- -- 2. The fallback project per organisation: the oldest live one. ---------
CREATE TEMPORARY TABLE dashboard_fallback_project AS
SELECT DISTINCT ON (organization_id) organization_id, id AS project_id
FROM projects
WHERE deleted_at IS NULL
ORDER BY organization_id, created_at ASC, id ASC;

-- -- 3. Re-home each of the four other homes. -------------------------------
UPDATE "dashboards" AS d
SET project_id = c.project_id
FROM "channels" AS c
WHERE d.home = 'channel' AND d.channel_id = c.id AND c.project_id IS NOT NULL;

UPDATE "dashboards" AS d
SET project_id = p.id
FROM (
  SELECT DISTINCT ON (team_id) team_id, id
  FROM projects
  WHERE deleted_at IS NULL AND team_id IS NOT NULL
  ORDER BY team_id, created_at ASC, id ASC
) AS p
WHERE d.home = 'team' AND d.team_id = p.team_id;

UPDATE "dashboards" AS d
SET project_id = f.project_id
FROM dashboard_fallback_project AS f
WHERE d.project_id IS NULL AND d.organization_id = f.organization_id;

-- A personal dashboard keeps its rows but leaves every list: parking it in a
-- project without archiving it would show one person's private dashboard to
-- that project's members.
UPDATE "dashboards"
SET archived_at = COALESCE(archived_at, NOW())
WHERE home = 'personal';

-- -- 4. Anything still unplaceable has nowhere to be shown. -----------------
DELETE FROM "dashboards" WHERE project_id IS NULL;

-- -- 5. Collapse the shape. -------------------------------------------------
DROP INDEX IF EXISTS "dashboards_organization_id_home_archived_at_idx";
DROP INDEX IF EXISTS "dashboards_organization_id_project_id_idx";

ALTER TABLE "dashboards"
  DROP COLUMN "home",
  DROP COLUMN "team_id",
  DROP COLUMN "channel_id",
  DROP COLUMN "owner_user_id";

ALTER TABLE "dashboards" ALTER COLUMN "project_id" SET NOT NULL;

ALTER TABLE "dashboards"
  ADD CONSTRAINT "dashboards_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "dashboards_organization_id_project_id_archived_at_idx"
  ON "dashboards" ("organization_id", "project_id", "archived_at");

DROP TYPE "DashboardHome";
