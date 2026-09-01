-- ─────────────────────────────────────────────────────────────────────────────
-- Partition the flattened shared Organization into per-UOA-org Organizations.
--
-- Retires the 2026-07-10 "one shared Nessie Organization, one Project+Team per
-- UOA workspace" model (docs/plans/2026-07-10-slack-workspace-login-nessie.md):
-- from now on every UOA organization gets its own Nessie Organization
-- (organizations.external_org_id, added by 20260815170000).
--
-- Rules (pinned contract):
--   ADOPTION — an organization containing UOA-linked teams
--     (teams.external_org_id IS NOT NULL, reached via its projects) adopts the
--     PLURALITY external_org_id among those teams; tie → the external_org_id
--     of the oldest such team. The adopting organization keeps all its rows.
--   SPLIT — every OTHER distinct external_org_id in that organization gets a
--     new Organization ("Organisation " || left(ext, 8) placeholder name; the
--     app syncs the real name at next login), and that UOA org's workspaces
--     move there: the Team, its parent Project, and every row hanging off the
--     project / team / its channels / threads / messages / agents / runs.
--   Per-table classification (stated at each statement below):
--     (a) rows reachable from a moved project/team/channel/agent/thread →
--         organization_id is rewritten to the new org
--     (b) per-(org,user) membership rows → new organization_members rows are
--         seeded for users holding team_members rows in moved teams,
--         role = GREATEST(team roles), owner > admin > member > viewer
--         (the UOA claim projection corrects roles at next login)
--     (c) product_account_links move only when the user has NO team membership
--         left in the old org (and their moved teams land in exactly one new
--         org); otherwise they stay — per-org links are created lazily at next
--         login, so split-org users re-login once
--     (d) genuinely org-global rows stay with the adopting org
--
-- Local-mode instances (no UOA-linked teams) and organizations whose teams all
-- share one external org id are perfect no-ops beyond adopting the id: every
-- temp set below is empty, so every UPDATE/INSERT touches zero rows.
--
-- Prisma runs this file in one transaction. Guards (`external_org_id IS NULL`
-- on adoption, reuse of a pre-existing org holding a split external id, and
-- old-org-equality predicates on every row move) make a partially-adopted
-- state safe: nothing double-applies and nothing flips an already-adopted id.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ 0. Precondition: a project has at most one workspace team ═══════════════
-- In the flattened model each UOA workspace provisioned exactly one
-- Project + Team pair, so a project must never contain teams of two different
-- external orgs. If one does, partitioning it is ambiguous — fail loudly
-- rather than guess.
DO $$
DECLARE
  bad RECORD;
BEGIN
  SELECT p.id AS project_id, count(DISTINCT t.external_org_id) AS ext_count
    INTO bad
    FROM projects p
    JOIN teams t ON t.project_id = p.id
   WHERE t.external_org_id IS NOT NULL
   GROUP BY p.id
  HAVING count(DISTINCT t.external_org_id) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'partition_uoa_organizations: project % contains teams of % distinct UOA external orgs; a project must belong to exactly one workspace. Resolve the mixed project manually, then re-run the migration.',
      bad.project_id, bad.ext_count;
  END IF;
END $$;

-- ═══ 1. UOA team inventory ═══════════════════════════════════════════════════
CREATE TEMP TABLE _uoa_teams ON COMMIT DROP AS
SELECT t.id         AS team_id,
       t.project_id AS project_id,
       p.organization_id AS org_id,
       t.external_org_id AS ext,
       t.created_at AS team_created_at
  FROM teams t
  JOIN projects p ON p.id = t.project_id
 WHERE t.external_org_id IS NOT NULL;

-- ═══ 2. Adoption: plurality external org id, tie → oldest team's ═════════════
CREATE TEMP TABLE _adoption ON COMMIT DROP AS
SELECT DISTINCT ON (org_id) org_id, ext
  FROM (SELECT org_id, ext,
               count(*)             AS team_count,
               min(team_created_at) AS oldest_team
          FROM _uoa_teams
         GROUP BY org_id, ext) g
 ORDER BY org_id, team_count DESC, oldest_team ASC;

-- Guard: an organization that already carries an external_org_id (partially
-- applied earlier state) keeps it — adoption never overwrites.
UPDATE organizations o
   SET external_org_id = a.ext
  FROM _adoption a
 WHERE o.id = a.org_id
   AND o.external_org_id IS NULL;

-- ═══ 3. Split targets: one new Organization per other external org id ════════
-- _splits reads the LIVE organizations.external_org_id (just adopted or
-- pre-existing), so re-running over a partially-adopted state cannot classify
-- the adopted id as a split.
CREATE TEMP TABLE _splits ON COMMIT DROP AS
SELECT DISTINCT ut.org_id AS old_org_id, ut.ext
  FROM _uoa_teams ut
  JOIN organizations o ON o.id = ut.org_id
 WHERE ut.ext IS DISTINCT FROM o.external_org_id;

CREATE TEMP TABLE _split_orgs ON COMMIT DROP AS
SELECT DISTINCT old_org_id FROM _splits;

-- Reuse a pre-existing organization already bound to the external id (the
-- unique index guarantees at most one); otherwise mint a new org id.
CREATE TEMP TABLE _ext_target ON COMMIT DROP AS
SELECT s.ext,
       COALESCE(o.id, gen_random_uuid()) AS new_org_id,
       (o.id IS NOT NULL)                AS pre_existing
  FROM (SELECT DISTINCT ext FROM _splits) s
  LEFT JOIN organizations o ON o.external_org_id = s.ext;

INSERT INTO organizations (id, name, external_org_id, strip_image_metadata, created_at, updated_at)
SELECT new_org_id,
       'Organisation ' || left(ext, 8),
       ext,
       TRUE,
       now(),
       now()
  FROM _ext_target
 WHERE NOT pre_existing;

-- ═══ 4. Moved-entity sets ════════════════════════════════════════════════════
-- All sets are materialized BEFORE any base-table update, so derivations read
-- the pre-move state. Every set carries (old_org_id, new_org_id); every row
-- move below is guarded by `organization_id = old_org_id`, which both scopes
-- the move to split orgs and makes later lower-priority derivations skip rows
-- a higher-priority derivation already moved.

-- The whole project moves, including any local (external_org_id IS NULL) teams
-- inside it — they are part of the workspace's project.
CREATE TEMP TABLE _moved_projects ON COMMIT DROP AS
SELECT ut.project_id, ut.org_id AS old_org_id, tgt.new_org_id
  FROM (SELECT DISTINCT project_id, org_id, ext FROM _uoa_teams) ut
  JOIN _splits s ON s.old_org_id = ut.org_id AND s.ext = ut.ext
  JOIN _ext_target tgt ON tgt.ext = ut.ext;
CREATE INDEX ON _moved_projects (project_id);

CREATE TEMP TABLE _moved_teams ON COMMIT DROP AS
SELECT t.id AS team_id, mp.old_org_id, mp.new_org_id
  FROM teams t
  JOIN _moved_projects mp ON mp.project_id = t.project_id;
CREATE INDEX ON _moved_teams (team_id);

CREATE TEMP TABLE _moved_channels ON COMMIT DROP AS
SELECT c.id AS channel_id, mp.old_org_id, mp.new_org_id
  FROM channels c
  JOIN _moved_projects mp ON mp.project_id = c.project_id;
CREATE INDEX ON _moved_channels (channel_id);

CREATE TEMP TABLE _moved_threads ON COMMIT DROP AS
SELECT th.id AS thread_id, mc.old_org_id, mc.new_org_id
  FROM threads th
  JOIN _moved_channels mc ON mc.channel_id = th.channel_id;
CREATE INDEX ON _moved_threads (thread_id);

CREATE TEMP TABLE _moved_messages ON COMMIT DROP AS
SELECT m.id AS message_id, mt.old_org_id, mt.new_org_id
  FROM messages m
  JOIN _moved_threads mt ON mt.thread_id = m.thread_id;
CREATE INDEX ON _moved_messages (message_id);

-- An agent moves when it is anchored to a moved project or team. An org-level
-- agent (no project/team) stays with the adopting org even when bound to a
-- moved channel: shared agents are organization resources and may be bound
-- across projects; membership in the new org's channels is re-evaluated by the
-- app, not guessed here.
CREATE TEMP TABLE _moved_agents ON COMMIT DROP AS
SELECT DISTINCT a.id AS agent_id, x.old_org_id, x.new_org_id
  FROM agents a
  JOIN LATERAL (
    SELECT mp.old_org_id, mp.new_org_id
      FROM _moved_projects mp WHERE mp.project_id = a.project_id
    UNION
    SELECT mt.old_org_id, mt.new_org_id
      FROM _moved_teams mt WHERE mt.team_id = a.team_id
  ) x ON TRUE
 WHERE a.organization_id = x.old_org_id;
CREATE INDEX ON _moved_agents (agent_id);

-- Runs have no org column; the thread is their location and the authority for
-- everything scoped by run below.
CREATE TEMP TABLE _moved_runs ON COMMIT DROP AS
SELECT r.id AS run_id, mt.old_org_id, mt.new_org_id
  FROM runs r
  JOIN _moved_threads mt ON mt.thread_id = r.thread_id;
CREATE INDEX ON _moved_runs (run_id);

-- A task moves with its project; a project-less task (PA / run-created) moves
-- with the run that owns it. Tasks with neither stay with the adopting org.
CREATE TEMP TABLE _moved_tasks ON COMMIT DROP AS
SELECT t.id AS task_id, mp.old_org_id, mp.new_org_id
  FROM tasks t
  JOIN _moved_projects mp ON mp.project_id = t.project_id
 WHERE t.organization_id = mp.old_org_id
UNION
SELECT t.id, mr.old_org_id, mr.new_org_id
  FROM tasks t
  JOIN _moved_runs mr ON mr.run_id = t.run_id
 WHERE t.project_id IS NULL
   AND t.organization_id = mr.old_org_id;
CREATE INDEX ON _moved_tasks (task_id);

-- Knowledge spaces/pages carry a NOT NULL project_id: they move with it.
CREATE TEMP TABLE _moved_spaces ON COMMIT DROP AS
SELECT ks.id AS space_id, mp.old_org_id, mp.new_org_id
  FROM knowledge_spaces ks
  JOIN _moved_projects mp ON mp.project_id = ks.project_id;
CREATE INDEX ON _moved_spaces (space_id);

CREATE TEMP TABLE _moved_pages ON COMMIT DROP AS
SELECT kp.id AS page_id, mp.old_org_id, mp.new_org_id
  FROM knowledge_pages kp
  JOIN _moved_projects mp ON mp.project_id = kp.project_id;
CREATE INDEX ON _moved_pages (page_id);

-- Plans anchor to (channel > project > team > run), first match wins.
CREATE TEMP TABLE _moved_plans ON COMMIT DROP AS
SELECT DISTINCT ON (p.id) p.id AS plan_id, x.old_org_id, x.new_org_id
  FROM plans p
  JOIN LATERAL (
    SELECT 1 AS prio, mc.old_org_id, mc.new_org_id
      FROM _moved_channels mc WHERE mc.channel_id = p.channel_id
    UNION ALL
    SELECT 2, mp.old_org_id, mp.new_org_id
      FROM _moved_projects mp WHERE mp.project_id = p.project_id
    UNION ALL
    SELECT 3, mt.old_org_id, mt.new_org_id
      FROM _moved_teams mt WHERE mt.team_id = p.team_id
    UNION ALL
    SELECT 4, mr.old_org_id, mr.new_org_id
      FROM _moved_runs mr WHERE mr.run_id = p.run_id
  ) x ON TRUE
 WHERE p.organization_id = x.old_org_id
 ORDER BY p.id, x.prio;
CREATE INDEX ON _moved_plans (plan_id);

-- Workflow installations anchor to (channel > project > team); an org-wide
-- installation (no scope refs) stays with the adopting org, and its template
-- ((d), org-global) always stays.
CREATE TEMP TABLE _moved_workflow_installations ON COMMIT DROP AS
SELECT DISTINCT ON (wi.id) wi.id AS installation_id, x.old_org_id, x.new_org_id
  FROM workflow_installations wi
  JOIN LATERAL (
    SELECT 1 AS prio, mc.old_org_id, mc.new_org_id
      FROM _moved_channels mc WHERE mc.channel_id = wi.channel_id
    UNION ALL
    SELECT 2, mp.old_org_id, mp.new_org_id
      FROM _moved_projects mp WHERE mp.project_id = wi.project_id
    UNION ALL
    SELECT 3, mt.old_org_id, mt.new_org_id
      FROM _moved_teams mt WHERE mt.team_id = wi.team_id
  ) x ON TRUE
 WHERE wi.organization_id = x.old_org_id
 ORDER BY wi.id, x.prio;
CREATE INDEX ON _moved_workflow_installations (installation_id);

-- Workflow runs follow their installation.
CREATE TEMP TABLE _moved_workflow_runs ON COMMIT DROP AS
SELECT wr.id AS workflow_run_id, mwi.old_org_id, mwi.new_org_id
  FROM workflow_runs wr
  JOIN _moved_workflow_installations mwi ON mwi.installation_id = wr.installation_id
 WHERE wr.organization_id = mwi.old_org_id;
CREATE INDEX ON _moved_workflow_runs (workflow_run_id);

-- Project/team/channel-scoped MCP connector installs move with their scope.
-- Organization- and user-scoped installs stay with the adopting org ((d) /
-- per-user; user-scope connectors surface only in the installing user's PA
-- runs and are re-scoped at next login).
CREATE TEMP TABLE _moved_mcp_instances ON COMMIT DROP AS
SELECT DISTINCT ON (i.id) i.id AS instance_id, x.old_org_id, x.new_org_id
  FROM mcp_server_instances i
  JOIN LATERAL (
    SELECT mp.old_org_id, mp.new_org_id
      FROM _moved_projects mp
     WHERE i.scope_type = 'project' AND mp.project_id = i.scope_id
    UNION ALL
    SELECT mt.old_org_id, mt.new_org_id
      FROM _moved_teams mt
     WHERE i.scope_type = 'team' AND mt.team_id = i.scope_id
    UNION ALL
    SELECT mc.old_org_id, mc.new_org_id
      FROM _moved_channels mc
     WHERE i.scope_type = 'channel' AND mc.channel_id = i.scope_id
  ) x ON TRUE
 WHERE i.organization_id = x.old_org_id
 ORDER BY i.id;
CREATE INDEX ON _moved_mcp_instances (instance_id);

-- Dashboards anchor to their home scope. `personal` and `organization`
-- dashboards stay with the adopting org ((d) / per-user).
CREATE TEMP TABLE _moved_dashboards ON COMMIT DROP AS
SELECT DISTINCT ON (d.id) d.id AS dashboard_id, x.old_org_id, x.new_org_id
  FROM dashboards d
  JOIN LATERAL (
    SELECT 1 AS prio, mc.old_org_id, mc.new_org_id
      FROM _moved_channels mc WHERE mc.channel_id = d.channel_id
    UNION ALL
    SELECT 2, mp.old_org_id, mp.new_org_id
      FROM _moved_projects mp WHERE mp.project_id = d.project_id
    UNION ALL
    SELECT 3, mt.old_org_id, mt.new_org_id
      FROM _moved_teams mt WHERE mt.team_id = d.team_id
  ) x ON TRUE
 WHERE d.organization_id = x.old_org_id
 ORDER BY d.id, x.prio;
CREATE INDEX ON _moved_dashboards (dashboard_id);

-- A dashboard data source moves only when every dashboard using it moved (and
-- at least one did): it is an org-shared resource, and a source referenced
-- from both sides must stay readable where most governance (credential
-- authority, org admins) lives — the adopting org.
CREATE TEMP TABLE _moved_dashboard_sources ON COMMIT DROP AS
SELECT s.id AS source_id, md.old_org_id, md.new_org_id
  FROM dashboard_data_sources s
  JOIN dashboard_widgets w ON w.source_id = s.id
  JOIN _moved_dashboards md ON md.dashboard_id = w.dashboard_id
 WHERE s.organization_id = md.old_org_id
 GROUP BY s.id, md.old_org_id, md.new_org_id
HAVING NOT EXISTS (
  SELECT 1
    FROM dashboard_widgets w2
   WHERE w2.source_id = s.id
     AND w2.dashboard_id NOT IN (SELECT dashboard_id FROM _moved_dashboards)
);
CREATE INDEX ON _moved_dashboard_sources (source_id);

-- (b) membership seeding inputs and (c) account-link moves are derived from
-- the PRE-move state, before any base table is updated.
-- A user's remaining membership in the old org = a team_members row on a team
-- whose project is still in the old org and which is not itself moving.
CREATE TEMP TABLE _link_moves ON COMMIT DROP AS
SELECT mt.old_org_id, tm.user_id, min(mt.new_org_id::text)::uuid AS new_org_id
  FROM team_members tm
  JOIN _moved_teams mt ON mt.team_id = tm.team_id
 GROUP BY mt.old_org_id, tm.user_id
HAVING count(DISTINCT mt.new_org_id) = 1
   AND NOT EXISTS (
     SELECT 1
       FROM team_members tm2
       JOIN teams t2 ON t2.id = tm2.team_id
       JOIN projects p2 ON p2.id = t2.project_id
      WHERE tm2.user_id = tm.user_id
        AND p2.organization_id = mt.old_org_id
        AND t2.id NOT IN (SELECT team_id FROM _moved_teams)
   );

-- ═══ 5. Row moves ════════════════════════════════════════════════════════════
-- Tables WITHOUT an organization_id column (teams, team_members,
-- project_members, channel_members, threads, thread_read_states, messages,
-- message_reactions, message_thread_follows, message_conversation_read_states,
-- thread_stream_events, agent_bindings, runs, run_document_chunks,
-- run_thinking_chunks, run_thread_pending_messages, agent_triggers,
-- agent_trigger_deliveries, plan_steps, workflow_step_runs, execution_leases,
-- tool_grants, task_events, tool_calls, queue_jobs, executor_* children,
-- policy_bindings, knowledge_page_versions, thought_links, thought_audit_logs,
-- thought_recalls, calls, call_participants, comms_* children,
-- mcp_server_credential_overrides, user_status_schedules, users,
-- refresh_tokens, push_registration_generations, push_credentials,
-- mcp_oauth_secret, mcp_oauth_states, rate_limit_buckets, integrated_products)
-- move implicitly with their FK parent and need no statement.
-- uoa_session_credentials / uoa_workspace_switch_intents carry UOA's OWN
-- opaque organization/team id strings, not local Organization ids — untouched.

-- (a) projects and their direct project-scoped children.
UPDATE projects p
   SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE p.id = mp.project_id
   AND p.organization_id = mp.old_org_id;

UPDATE board_columns b
   SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE b.project_id = mp.project_id
   AND b.organization_id = mp.old_org_id;

UPDATE iterations i
   SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE i.project_id = mp.project_id
   AND i.organization_id = mp.old_org_id;

-- (a) channels.
UPDATE channels c
   SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE c.id = mc.channel_id
   AND c.organization_id = mc.old_org_id;

-- (a) agents anchored to a moved project/team.
UPDATE agents a
   SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE a.id = ma.agent_id
   AND a.organization_id = ma.old_org_id;

-- (a) knowledge workspace: spaces, pages, chunks (all carry NOT NULL
-- project_id), space members, wikilinks, labels, annotations + reactions.
UPDATE knowledge_spaces ks
   SET organization_id = ms.new_org_id
  FROM _moved_spaces ms
 WHERE ks.id = ms.space_id
   AND ks.organization_id = ms.old_org_id;

UPDATE knowledge_pages kp
   SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE kp.id = mpg.page_id
   AND kp.organization_id = mpg.old_org_id;

UPDATE knowledge_page_chunks kc
   SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE kc.page_id = mpg.page_id
   AND kc.organization_id = mpg.old_org_id;

UPDATE knowledge_space_members ksm
   SET organization_id = ms.new_org_id
  FROM _moved_spaces ms
 WHERE ksm.space_id = ms.space_id
   AND ksm.organization_id = ms.old_org_id;

-- Wikilinks belong to their source page; a link whose target stayed behind
-- keeps working as an unresolved-by-org reference the app re-resolves.
UPDATE knowledge_page_links kl
   SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE kl.source_page_id = mpg.page_id
   AND kl.organization_id = mpg.old_org_id;

UPDATE page_labels pl
   SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE pl.page_id = mpg.page_id
   AND pl.organization_id = mpg.old_org_id;

UPDATE knowledge_page_annotations an
   SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE an.page_id = mpg.page_id
   AND an.organization_id = mpg.old_org_id;

UPDATE knowledge_page_annotation_reactions ar
   SET organization_id = an.organization_id
  FROM knowledge_page_annotations an
 WHERE an.id = ar.annotation_id
   AND ar.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND ar.organization_id <> an.organization_id;

-- (a) tasks (project first, then run-owned project-less tasks).
UPDATE tasks t
   SET organization_id = mtk.new_org_id
  FROM _moved_tasks mtk
 WHERE t.id = mtk.task_id
   AND t.organization_id = mtk.old_org_id;

-- (a) plans.
UPDATE plans p
   SET organization_id = mpl.new_org_id
  FROM _moved_plans mpl
 WHERE p.id = mpl.plan_id
   AND p.organization_id = mpl.old_org_id;

-- (a) run-scoped rows follow the run's thread.
UPDATE run_checkpoints rc
   SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE rc.run_id = mr.run_id
   AND rc.organization_id = mr.old_org_id;

UPDATE run_document_sessions rds
   SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE rds.run_id = mr.run_id
   AND rds.organization_id = mr.old_org_id;

UPDATE run_basis_scopes rbs
   SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE rbs.run_id = mr.run_id
   AND rbs.organization_id = mr.old_org_id;

-- (a) message-scoped rows.
UPDATE message_basis_scopes mbs
   SET organization_id = mm.new_org_id
  FROM _moved_messages mm
 WHERE mbs.message_id = mm.message_id
   AND mbs.organization_id = mm.old_org_id;

UPDATE disclosure_grants dg
   SET organization_id = mm.new_org_id
  FROM _moved_messages mm
 WHERE dg.message_id = mm.message_id
   AND dg.organization_id = mm.old_org_id;

UPDATE scope_disclosure_grants sdg
   SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE sdg.destination_channel_id = mc.channel_id
   AND sdg.organization_id = mc.old_org_id;

-- (a) user alerts anchored to a moved surface (channel > project > thread >
-- message > task > knowledge page); alerts with no resource refs stay (d).
UPDATE user_alerts ua SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE ua.channel_id = mc.channel_id AND ua.organization_id = mc.old_org_id;
UPDATE user_alerts ua SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE ua.project_id = mp.project_id AND ua.organization_id = mp.old_org_id;
UPDATE user_alerts ua SET organization_id = mt.new_org_id
  FROM _moved_threads mt
 WHERE ua.thread_id = mt.thread_id AND ua.organization_id = mt.old_org_id;
UPDATE user_alerts ua SET organization_id = mm.new_org_id
  FROM _moved_messages mm
 WHERE ua.message_id = mm.message_id AND ua.organization_id = mm.old_org_id;
UPDATE user_alerts ua SET organization_id = mtk.new_org_id
  FROM _moved_tasks mtk
 WHERE ua.task_id = mtk.task_id AND ua.organization_id = mtk.old_org_id;
UPDATE user_alerts ua SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE ua.knowledge_page_id = mpg.page_id AND ua.organization_id = mpg.old_org_id;

-- (a) realtime backlog rows follow their channel (channel_id is NOT NULL).
UPDATE realtime_events re
   SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE re.channel_id = mc.channel_id
   AND re.organization_id = mc.old_org_id;

-- (a) ephemeral surface presence follows the surface it points at (channel >
-- project > knowledge space); ref-less rows stay (d) and self-heal on the
-- next 25-second heartbeat. user_presence (no resource ref) stays (d).
UPDATE user_push_surface_presence up SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE up.channel_id = mc.channel_id AND up.organization_id = mc.old_org_id;
UPDATE user_push_surface_presence up SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE up.project_id = mp.project_id AND up.organization_id = mp.old_org_id;
UPDATE user_push_surface_presence up SET organization_id = ms.new_org_id
  FROM _moved_spaces ms
 WHERE up.knowledge_space_id = ms.space_id AND up.organization_id = ms.old_org_id;

-- (a) memory rows anchored to a moved scope (channel > thread > project >
-- team). Purely user-scoped thoughts (no scope refs) stay with the adopting
-- org (d)/(b): recall re-scopes by audience at query time.
UPDATE thoughts th SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE th.channel_id = mc.channel_id AND th.organization_id = mc.old_org_id;
UPDATE thoughts th SET organization_id = mt.new_org_id
  FROM _moved_threads mt
 WHERE th.thread_id = mt.thread_id AND th.organization_id = mt.old_org_id;
UPDATE thoughts th SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE th.project_id = mp.project_id AND th.organization_id = mp.old_org_id;
UPDATE thoughts th SET organization_id = mtm.new_org_id
  FROM _moved_teams mtm
 WHERE th.team_id = mtm.team_id AND th.organization_id = mtm.old_org_id;

UPDATE thought_reasonings tr
   SET organization_id = th.organization_id
  FROM thoughts th
 WHERE th.id = tr.thought_id
   AND tr.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND tr.organization_id <> th.organization_id;

-- (a) approval requests (channel > project > team > task > run > agent).
UPDATE approval_requests apr SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE apr.channel_id = mc.channel_id AND apr.organization_id = mc.old_org_id;
UPDATE approval_requests apr SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE apr.project_id = mp.project_id AND apr.organization_id = mp.old_org_id;
UPDATE approval_requests apr SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE apr.team_id = mt.team_id AND apr.organization_id = mt.old_org_id;
UPDATE approval_requests apr SET organization_id = mtk.new_org_id
  FROM _moved_tasks mtk
 WHERE apr.task_id = mtk.task_id AND apr.organization_id = mtk.old_org_id;
UPDATE approval_requests apr SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE apr.run_id = mr.run_id AND apr.organization_id = mr.old_org_id;
UPDATE approval_requests apr SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE apr.agent_id = ma.agent_id AND apr.organization_id = ma.old_org_id;

-- (a) resource locks (run > plan > agent).
UPDATE resource_locks rl SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE rl.run_id = mr.run_id AND rl.organization_id = mr.old_org_id;
UPDATE resource_locks rl SET organization_id = mpl.new_org_id
  FROM _moved_plans mpl
 WHERE rl.plan_id = mpl.plan_id AND rl.organization_id = mpl.old_org_id;
UPDATE resource_locks rl SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE rl.agent_id = ma.agent_id AND rl.organization_id = ma.old_org_id;

-- (a) temporary context sessions (thread > run > agent); ref-less rows stay.
UPDATE temporary_context_sessions tcs SET organization_id = mt.new_org_id
  FROM _moved_threads mt
 WHERE tcs.thread_id = mt.thread_id AND tcs.organization_id = mt.old_org_id;
UPDATE temporary_context_sessions tcs SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE tcs.run_id = mr.run_id AND tcs.organization_id = mr.old_org_id;
UPDATE temporary_context_sessions tcs SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE tcs.agent_id = ma.agent_id AND tcs.organization_id = ma.old_org_id;

-- (a) agent mailbox (channel > thread > plan > workflow run > to-agent);
-- ref-less coordination rows stay with the adopting org.
UPDATE agent_mailbox_messages amm SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE amm.channel_id = mc.channel_id AND amm.organization_id = mc.old_org_id;
UPDATE agent_mailbox_messages amm SET organization_id = mt.new_org_id
  FROM _moved_threads mt
 WHERE amm.thread_id = mt.thread_id AND amm.organization_id = mt.old_org_id;
UPDATE agent_mailbox_messages amm SET organization_id = mpl.new_org_id
  FROM _moved_plans mpl
 WHERE amm.plan_id = mpl.plan_id AND amm.organization_id = mpl.old_org_id;
UPDATE agent_mailbox_messages amm SET organization_id = mwr.new_org_id
  FROM _moved_workflow_runs mwr
 WHERE amm.workflow_run_id = mwr.workflow_run_id AND amm.organization_id = mwr.old_org_id;
UPDATE agent_mailbox_messages amm SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE amm.to_agent_id = ma.agent_id AND amm.organization_id = ma.old_org_id;

-- (a) workflow installations/runs/state. Templates stay (d): org-global
-- definitions; an installation in the new org keeps its template FK, and the
-- app treats cross-org template reads as it does today for shared templates.
UPDATE workflow_installations wi
   SET organization_id = mwi.new_org_id
  FROM _moved_workflow_installations mwi
 WHERE wi.id = mwi.installation_id
   AND wi.organization_id = mwi.old_org_id;

UPDATE workflow_runs wr
   SET organization_id = mwr.new_org_id
  FROM _moved_workflow_runs mwr
 WHERE wr.id = mwr.workflow_run_id
   AND wr.organization_id = mwr.old_org_id;

UPDATE workflow_state_entries wse
   SET organization_id = mwi.new_org_id
  FROM _moved_workflow_installations mwi
 WHERE wse.workflow_installation_id = mwi.installation_id
   AND wse.organization_id = mwi.old_org_id;

-- (a) execution environments (channel > project > team > run > workflow run);
-- templates with no scope refs and org-scoped runners stay (d).
UPDATE execution_environment_templates eet SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE eet.channel_id = mc.channel_id AND eet.organization_id = mc.old_org_id;
UPDATE execution_environment_templates eet SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE eet.project_id = mp.project_id AND eet.organization_id = mp.old_org_id;
UPDATE execution_environment_templates eet SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE eet.team_id = mt.team_id AND eet.organization_id = mt.old_org_id;

UPDATE execution_environment_instances eei SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE eei.channel_id = mc.channel_id AND eei.organization_id = mc.old_org_id;
UPDATE execution_environment_instances eei SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE eei.project_id = mp.project_id AND eei.organization_id = mp.old_org_id;
UPDATE execution_environment_instances eei SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE eei.team_id = mt.team_id AND eei.organization_id = mt.old_org_id;
UPDATE execution_environment_instances eei SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE eei.run_id = mr.run_id AND eei.organization_id = mr.old_org_id;
UPDATE execution_environment_instances eei SET organization_id = mwr.new_org_id
  FROM _moved_workflow_runs mwr
 WHERE eei.workflow_run_id = mwr.workflow_run_id AND eei.organization_id = mwr.old_org_id;

-- Usage ledger rows follow their instance's final org (append-only ops
-- telemetry; keeping them beside the instance keeps per-org sums truthful).
UPDATE execution_usage_ledger eul
   SET organization_id = eei.organization_id
  FROM execution_environment_instances eei
 WHERE eei.id = eul.instance_id
   AND eul.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND eul.organization_id <> eei.organization_id;

-- (a) executors paired into a moved project; org/private-scoped executors stay.
UPDATE executors e
   SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE e.project_id = mp.project_id
   AND e.organization_id = mp.old_org_id;

-- (a) MCP connector installs scoped to a moved project/team/channel, and the
-- tool projections that belong to them. Guarded against a scope-key collision
-- in a pre-existing target org (unique (organization_id, scope_key, tool_id)).
UPDATE mcp_server_instances i
   SET organization_id = mi.new_org_id
  FROM _moved_mcp_instances mi
 WHERE i.id = mi.instance_id
   AND i.organization_id = mi.old_org_id;

UPDATE tool_registry_entries tre
   SET organization_id = mi.new_org_id
  FROM _moved_mcp_instances mi
 WHERE tre.mcp_instance_id = mi.instance_id
   AND tre.organization_id = mi.old_org_id
   AND NOT EXISTS (
     SELECT 1 FROM tool_registry_entries x
      WHERE x.organization_id = mi.new_org_id
        AND x.scope_key = tre.scope_key
        AND x.tool_id = tre.tool_id
   );

-- (a) policy rules whose scope targets a moved resource (scope_id is TEXT).
-- organization/tool/user-scoped rules stay with the adopting org (d).
UPDATE policy_rules pr SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE pr.scope = 'project' AND pr.scope_id = mp.project_id::text
   AND pr.organization_id = mp.old_org_id;
UPDATE policy_rules pr SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE pr.scope = 'team' AND pr.scope_id = mt.team_id::text
   AND pr.organization_id = mt.old_org_id;
UPDATE policy_rules pr SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE pr.scope = 'channel' AND pr.scope_id = mc.channel_id::text
   AND pr.organization_id = mc.old_org_id;
UPDATE policy_rules pr SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE pr.scope = 'agent' AND pr.scope_id = ma.agent_id::text
   AND pr.organization_id = ma.old_org_id;

-- (a)/(d) budgets: project/team-scoped budgets move with their scope; budgets
-- scoped to the organization itself stay with the adopting org.
UPDATE budgets b SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE b.scope_type = 'project' AND b.scope_id = mp.project_id
   AND b.organization_id = mp.old_org_id;
UPDATE budgets b SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE b.scope_type = 'team' AND b.scope_id = mt.team_id
   AND b.organization_id = mt.old_org_id;

UPDATE budget_alerts ba SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE ba.scope_type = 'project' AND ba.scope_id = mp.project_id
   AND ba.organization_id = mp.old_org_id;
UPDATE budget_alerts ba SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE ba.scope_type = 'team' AND ba.scope_id = mt.team_id
   AND ba.organization_id = mt.old_org_id;

-- (a) favorites of a moved channel/agent (target_type: agent|channel|user).
-- User-target favorites stay (b)-shaped. Guarded against the (user, org,
-- target) unique key when the target org pre-existed.
UPDATE favorites f SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE f.target_type = 'channel' AND f.target_id = mc.channel_id
   AND f.organization_id = mc.old_org_id
   AND NOT EXISTS (
     SELECT 1 FROM favorites x
      WHERE x.user_id = f.user_id AND x.organization_id = mc.new_org_id
        AND x.target_type = f.target_type AND x.target_id = f.target_id
   );
UPDATE favorites f SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE f.target_type = 'agent' AND f.target_id = ma.agent_id
   AND f.organization_id = ma.old_org_id
   AND NOT EXISTS (
     SELECT 1 FROM favorites x
      WHERE x.user_id = f.user_id AND x.organization_id = ma.new_org_id
        AND x.target_type = f.target_type AND x.target_id = f.target_id
   );

-- (a) attachments that belong to a moved message, page (drawer or file-node
-- version), or moved agent's avatar. Uploader-only attachments (user avatars,
-- org logos, feedback screenshots) stay (d).
UPDATE attachments a SET organization_id = mm.new_org_id
  FROM _moved_messages mm
 WHERE a.message_id = mm.message_id AND a.organization_id = mm.old_org_id;
UPDATE attachments a SET organization_id = mpg.new_org_id
  FROM _moved_pages mpg
 WHERE a.knowledge_page_id = mpg.page_id AND a.organization_id = mpg.old_org_id;
UPDATE attachments a SET organization_id = mpg.new_org_id
  FROM knowledge_page_versions v
  JOIN _moved_pages mpg ON mpg.page_id = v.page_id
 WHERE a.id = v.attachment_id AND a.organization_id = mpg.old_org_id;
UPDATE attachments a SET organization_id = ma.new_org_id
  FROM agents ag
  JOIN _moved_agents ma ON ma.agent_id = ag.id
 WHERE a.id = ag.avatar_attachment_id AND a.organization_id = ma.old_org_id;

-- (a) push deliveries for a moved message; message-less delivery telemetry
-- stays (d).
UPDATE push_deliveries pd
   SET organization_id = mm.new_org_id
  FROM _moved_messages mm
 WHERE pd.message_id = mm.message_id
   AND pd.organization_id = mm.old_org_id;

-- (a) product integration rows follow their team.
UPDATE product_team_enablements pte
   SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE pte.team_id = mt.team_id
   AND pte.organization_id = mt.old_org_id;

UPDATE product_integration_runs pir
   SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE pir.team_id = mt.team_id
   AND pir.organization_id = mt.old_org_id;

-- (a) dashboards and their structure children; exclusively-moved data sources
-- and their datasets follow (see _moved_dashboard_sources). Grants on a moved
-- dashboard follow it; personal/org dashboards, shared sources, and
-- subject-scoped grants stay (d).
UPDATE dashboards d
   SET organization_id = md.new_org_id
  FROM _moved_dashboards md
 WHERE d.id = md.dashboard_id
   AND d.organization_id = md.old_org_id;

UPDATE dashboard_widgets dw
   SET organization_id = md.new_org_id
  FROM _moved_dashboards md
 WHERE dw.dashboard_id = md.dashboard_id
   AND dw.organization_id = md.old_org_id;

UPDATE dashboard_versions dv
   SET organization_id = md.new_org_id
  FROM _moved_dashboards md
 WHERE dv.dashboard_id = md.dashboard_id
   AND dv.organization_id = md.old_org_id;

UPDATE dashboard_widget_snapshots dws
   SET organization_id = md.new_org_id
  FROM _moved_dashboards md
 WHERE dws.dashboard_id = md.dashboard_id
   AND dws.organization_id = md.old_org_id;

UPDATE dashboard_data_sources dds
   SET organization_id = mds.new_org_id
  FROM _moved_dashboard_sources mds
 WHERE dds.id = mds.source_id
   AND dds.organization_id = mds.old_org_id
   AND NOT EXISTS (
     SELECT 1 FROM dashboard_data_sources x
      WHERE x.organization_id = mds.new_org_id AND x.name = dds.name
   );

UPDATE dashboard_datasets dd
   SET organization_id = dds.organization_id
  FROM dashboard_data_sources dds
 WHERE dds.id = dd.source_id
   AND dd.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND dd.organization_id <> dds.organization_id;

-- Dataset blobs live in attachments; keep the blob's org beside its dataset.
UPDATE attachments a
   SET organization_id = dd.organization_id
  FROM dashboard_datasets dd
 WHERE dd.attachment_id = a.id
   AND a.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND a.organization_id <> dd.organization_id;

UPDATE dashboard_grants dg
   SET organization_id = md.new_org_id
  FROM _moved_dashboards md
 WHERE dg.resource_type = 'dashboard'
   AND dg.resource_id = md.dashboard_id
   AND dg.organization_id = md.old_org_id;

UPDATE dashboard_embed_placements dep
   SET organization_id = dw.organization_id
  FROM dashboard_widgets dw
 WHERE dw.id = dep.widget_id
   AND dep.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND dep.organization_id <> dw.organization_id;
UPDATE dashboard_embed_placements dep
   SET organization_id = dws.organization_id
  FROM dashboard_widget_snapshots dws
 WHERE dws.id = dep.widget_snapshot_id
   AND dep.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND dep.organization_id <> dws.organization_id;

-- (a) accounting/audit ledgers reachable from a moved resource. These are
-- append-only, FK-less (or deliberately FK-less) telemetry: moving them keeps
-- per-org sums truthful for the org that now owns the workload. Rows with no
-- moved-resource ref stay with the adopting org (d).
-- token_ledger_events (channel > project > team > thread > run > task > agent):
UPDATE token_ledger_events tle SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE tle.channel_id = mc.channel_id AND tle.organization_id = mc.old_org_id;
UPDATE token_ledger_events tle SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE tle.project_id = mp.project_id AND tle.organization_id = mp.old_org_id;
UPDATE token_ledger_events tle SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE tle.team_id = mt.team_id AND tle.organization_id = mt.old_org_id;
UPDATE token_ledger_events tle SET organization_id = mth.new_org_id
  FROM _moved_threads mth
 WHERE tle.thread_id = mth.thread_id AND tle.organization_id = mth.old_org_id;
UPDATE token_ledger_events tle SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE tle.run_id = mr.run_id AND tle.organization_id = mr.old_org_id;
UPDATE token_ledger_events tle SET organization_id = mtk.new_org_id
  FROM _moved_tasks mtk
 WHERE tle.task_id = mtk.task_id AND tle.organization_id = mtk.old_org_id;
UPDATE token_ledger_events tle SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE tle.agent_id = ma.agent_id AND tle.organization_id = ma.old_org_id;

-- connector_usage_events (same derivation order):
UPDATE connector_usage_events cue SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE cue.channel_id = mc.channel_id AND cue.organization_id = mc.old_org_id;
UPDATE connector_usage_events cue SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE cue.project_id = mp.project_id AND cue.organization_id = mp.old_org_id;
UPDATE connector_usage_events cue SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE cue.team_id = mt.team_id AND cue.organization_id = mt.old_org_id;
UPDATE connector_usage_events cue SET organization_id = mth.new_org_id
  FROM _moved_threads mth
 WHERE cue.thread_id = mth.thread_id AND cue.organization_id = mth.old_org_id;
UPDATE connector_usage_events cue SET organization_id = mr.new_org_id
  FROM _moved_runs mr
 WHERE cue.run_id = mr.run_id AND cue.organization_id = mr.old_org_id;
UPDATE connector_usage_events cue SET organization_id = mtk.new_org_id
  FROM _moved_tasks mtk
 WHERE cue.task_id = mtk.task_id AND cue.organization_id = mtk.old_org_id;
UPDATE connector_usage_events cue SET organization_id = ma.new_org_id
  FROM _moved_agents ma
 WHERE cue.agent_id = ma.agent_id AND cue.organization_id = ma.old_org_id;

-- storage_usage_events (project > space > attachment): the signed-delta ledger
-- must follow the bytes it accounts, or a later FileService delete would debit
-- a different org than the store credited. Attachments were moved above, so
-- the attachment leg syncs to the attachment's final org.
UPDATE storage_usage_events sue SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE sue.project_id = mp.project_id AND sue.organization_id = mp.old_org_id;
UPDATE storage_usage_events sue SET organization_id = ms.new_org_id
  FROM _moved_spaces ms
 WHERE sue.space_id = ms.space_id AND sue.organization_id = ms.old_org_id;
UPDATE storage_usage_events sue
   SET organization_id = a.organization_id
  FROM attachments a
 WHERE a.id = sue.attachment_id
   AND sue.organization_id IN (SELECT old_org_id FROM _split_orgs)
   AND sue.organization_id <> a.organization_id;

-- audit_logs (channel > project > team): reachable rows move per the contract;
-- rows with no moved-resource ref stay with the adopting org (d).
UPDATE audit_logs al SET organization_id = mc.new_org_id
  FROM _moved_channels mc
 WHERE al.channel_id = mc.channel_id AND al.organization_id = mc.old_org_id;
UPDATE audit_logs al SET organization_id = mp.new_org_id
  FROM _moved_projects mp
 WHERE al.project_id = mp.project_id AND al.organization_id = mp.old_org_id;
UPDATE audit_logs al SET organization_id = mt.new_org_id
  FROM _moved_teams mt
 WHERE al.team_id = mt.team_id AND al.organization_id = mt.old_org_id;

-- Audit hash-chain epoch reset for every org a split touched (old and new).
-- The per-org SHA-256 chain (packages/db audit-chain.ts) binds each entry to
-- its organizationId AND its predecessor's entry_hash; partitioning both
-- rewrites organizationId on moved rows and removes rows from the old org's
-- sequence, so neither side could verify again. Resetting the affected orgs'
-- rows to the pre-chain epoch (both hashes NULL — the same state rows written
-- before the chain existed are in) restarts each chain at the first row
-- written after the partition, which the verifier already models as genesis.
UPDATE audit_logs
   SET prev_hash = NULL, entry_hash = NULL
 WHERE (prev_hash IS NOT NULL OR entry_hash IS NOT NULL)
   AND organization_id IN (
     SELECT old_org_id FROM _split_orgs
     UNION
     SELECT new_org_id FROM _ext_target
   );

-- ═══ 6. (b) organization membership seeding ══════════════════════════════════
-- Every user holding a team_members row in a moved team gets a membership in
-- the team's new org, at the GREATEST of their moved-team roles
-- (owner > admin > member > viewer). Their old-org membership rows are kept —
-- the UOA claim projection corrects both sides at next login.
INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
SELECT gen_random_uuid(),
       mt.new_org_id,
       tm.user_id,
       (CASE max(CASE tm.role::text
                   WHEN 'owner' THEN 4
                   WHEN 'admin' THEN 3
                   WHEN 'member' THEN 2
                   ELSE 1
                 END)
          WHEN 4 THEN 'owner'
          WHEN 3 THEN 'admin'
          WHEN 2 THEN 'member'
          ELSE 'viewer'
        END)::"MemberRole",
       now()
  FROM team_members tm
  JOIN _moved_teams mt ON mt.team_id = tm.team_id
 GROUP BY mt.new_org_id, tm.user_id
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- ═══ 7. (c) product account links ════════════════════════════════════════════
-- A user's links move to their new org only when they hold NO team membership
-- left in the old org and all their moved teams land in one new org
-- (_link_moves). Everyone else keeps their old-org link and gets a fresh
-- per-org link lazily at next login (split-org users re-login once, accepted).
UPDATE product_account_links pal
   SET organization_id = lm.new_org_id
  FROM _link_moves lm
 WHERE pal.organization_id = lm.old_org_id
   AND pal.user_id = lm.user_id
   AND NOT EXISTS (
     SELECT 1 FROM product_account_links x
      WHERE x.organization_id = lm.new_org_id
        AND x.user_id = pal.user_id
        AND x.product_slug = pal.product_slug
   );

-- ═══ 8. (d) rows that deliberately STAY with the adopting organization ═══════
-- Stated here so the classification is complete (no statement = no move):
--   organizations (settings/logo/strip_image_metadata) — org identity itself.
--   inference_providers / inference_models / inference_credential_bindings /
--     inference_routing_profiles — org inference control plane; new orgs
--     configure their own (deployment-level config still applies everywhere).
--   model_pricing_profiles, mcp_oauth_clients, product_webhook_secrets,
--     mcp_catalog_entries, tool_bundles — org-global integration state.
--   tool_registry_entries not owned by a moved MCP instance (builtins,
--     bundles, org-scoped registrations) — org-global tool plane.
--   workflow_templates — org-global definitions (installations moved above).
--   execution_runners, execution_environment_templates with no scope refs —
--     org-global capacity.
--   policy_rules scoped organization/tool/user — govern the org itself.
--   budgets / budget_alerts scoped to the organization itself.
--   audit_logs / token_ledger_events / connector_usage_events /
--     storage_usage_events with no moved-resource refs — org-level telemetry.
--   organization_members (old rows), user_statuses (+schedules/rules),
--     user_presence, device_tokens, web_push_subscriptions, feedback,
--     favorites of unmoved/user targets, comms_connections (+credentials,
--     resources, sync jobs, events, subscriptions, oauth states) — per-
--     (org,user) rows; recreated or re-scoped by the app at next login
--     (contract (b)/(c): only organization_members is seeded here).
--   product_account_links not matched by _link_moves — per contract (c).
--   agents with no project/team anchor — org-level shared agents.
--   tasks/thoughts/plans/alerts/etc. with no moved-resource refs — org-level.
--   uoa_session_credentials / uoa_workspace_switch_intents — organization_id
--     and team_id there are UOA's OWN opaque ids, not local Organization ids.
