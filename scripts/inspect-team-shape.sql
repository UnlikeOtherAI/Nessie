-- Sizes the Project/Team foreign-key inversion before it is attempted.
--
-- The model is Organisation -> Team -> Project -> Channel: a team IS
-- the SSO's team, and a project is Nessie's own, living inside exactly one
-- team (docs/standards/team-model.md). The schema has this INVERTED —
-- `Team.project_id` makes a Project the parent of a Team — and the fix is to
-- flip the relationship into `Project.team_id`, NOT to add a unique constraint
-- to the current direction, which would freeze the wrong shape.
--
-- This sizes that inversion: how many rows do not already fit one-project-per-
-- team, and what would have to be decided for those that do not.
--
-- Read-only. Safe to run against production.

\echo '== Projects by how many teams they hold =='
SELECT
  team_count,
  COUNT(*) AS projects
FROM (
  SELECT p.id, COUNT(t.id) AS team_count
  FROM projects p
  LEFT JOIN teams t ON t.project_id = p.id
  WHERE p.channel_root = false
  GROUP BY p.id
) shape
GROUP BY team_count
ORDER BY team_count;

\echo ''
\echo '== Projects holding more than one team (each needs a decision on inversion) =='
SELECT
  p.id           AS project_id,
  p.name         AS project_name,
  p.organization_id,
  COUNT(t.id)    AS team_count,
  STRING_AGG(t.name, ' | ' ORDER BY t.created_at) AS team_names,
  COUNT(t.external_team_id) AS uoa_bound_teams
FROM projects p
JOIN teams t ON t.project_id = p.id
WHERE p.channel_root = false
GROUP BY p.id, p.name, p.organization_id
HAVING COUNT(t.id) > 1
ORDER BY COUNT(t.id) DESC;

\echo ''
\echo '== Teams whose name has drifted from their project (the "{Name} Team" artefact) =='
SELECT
  t.id, t.name AS team_name, p.name AS project_name, t.external_team_id IS NOT NULL AS uoa_bound
FROM teams t
JOIN projects p ON p.id = t.project_id
WHERE p.channel_root = false
  AND t.name <> p.name
  AND t.name <> p.name || ' Team'
ORDER BY t.created_at;

\echo ''
\echo '== Project members who are not members of that project''s team(s) =='
\echo '-- If project membership is ever derived from team membership,'
\echo '-- these are the rows that would lose access, so they must be migrated.'
SELECT COUNT(*) AS orphaned_project_members
FROM project_members pm
JOIN projects p ON p.id = pm.project_id AND p.channel_root = false
WHERE NOT EXISTS (
  SELECT 1 FROM teams t
  JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = pm.user_id
  WHERE t.project_id = pm.project_id
);

\echo ''
\echo '== Channels whose team does not belong to their project =='
\echo '-- Nothing in the schema forbids this triple; if any exist, the 1:1'
\echo '-- migration has to decide where they land.'
SELECT COUNT(*) AS inconsistent_channels
FROM channels c
JOIN teams t ON t.id = c.team_id
WHERE c.team_id IS NOT NULL
  AND c.project_id IS NOT NULL
  AND t.project_id <> c.project_id;
