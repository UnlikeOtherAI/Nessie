-- Workflow authoring moves behind the project-operator grant
-- (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "The
-- project-operator capability").
--
-- `workflow_create`, `workflow_update`, `workflow_install`,
-- `workflow_trigger_create` and `workflow_run` carried no flag, so every
-- shared agent held them: it could author, install, arm (webhook, event and
-- cron triggers included) and start workflows as whichever owner was talking
-- to it, and on an unattended run as the creator a schedule reconstructs. They
-- are now verbs a shared agent reaches only on the project-operator arm — a
-- person's own live turn in a project channel it is bound to — with the
-- explicit `project_operator` grant. The Personal Assistant and the Agent
-- Designer keep them through their own arms, on live turns only, and need no
-- grant.
--
-- Access narrows; it is not carried over whole. Every ordinary, top-level,
-- live shared agent whose tool policy names one of those five tools `true` is
-- granted `project_operator` explicitly, so it keeps them on a person's own
-- turn in a project channel it is in. It loses them everywhere else: on its
-- scheduled, interval, webhook and event trigger fires, in a DM, and on a peer
-- delegation. And the grant is wider than workflows: it also lets the agent set
-- up projects, teams, channels, boards and their columns, labels, document
-- spaces and triggers for the person talking to it, as that person.
--
-- An agent that held them only by default (no key) is granted nothing: the
-- default was the hazard. An explicit `false` stays a denial; a deleted agent,
-- a spawned child and a system agent are left alone; and an agent whose policy
-- already names `project_operator` either way keeps its verdict.
--
-- Each agent granted is named, with its organisation and the tools that earned
-- the grant, in a WARNING line. A second WARNING names each granted agent whose
-- workflow use this narrows today: one with an enabled scheduled, interval,
-- webhook or event trigger, or one in no project channel the arm opens in.
-- WARNING rather than NOTICE because Postgres's default `log_min_messages` is
-- `warning`, so the lines land in the database server's log where an operator
-- can read them afterwards. The grant then shows on each agent's Tools page as
-- "Project operator", where its owner can take it back.

DO $$
DECLARE
  granted RECORD;
BEGIN
  FOR granted IN
    SELECT a.id, a.name, a.organization_id, allowed.tools, fires.types AS unattended_triggers,
           (rooms.count = 0) AS in_no_project_room
      FROM agents a
      CROSS JOIN LATERAL (
        SELECT string_agg(entry.key, ', ' ORDER BY entry.key) AS tools
          FROM jsonb_each(a.tool_policy) AS entry(key, value)
         WHERE entry.key IN (
                 'workflow_create', 'workflow_update', 'workflow_install',
                 'workflow_trigger_create', 'workflow_run'
               )
           AND entry.value = 'true'::jsonb
      ) AS allowed
      CROSS JOIN LATERAL (
        SELECT string_agg(DISTINCT t.type::text, ', ') AS types
          FROM agent_triggers t
         WHERE t.agent_id = a.id
           AND t.enabled = true
           AND t.type::text IN ('scheduled', 'interval', 'webhook', 'event')
      ) AS fires
      CROSS JOIN LATERAL (
        SELECT count(*) AS count
          FROM agent_bindings ab
          JOIN channels c ON c.id = ab.channel_id
          JOIN projects p ON p.id = c.project_id
         WHERE ab.agent_id = a.id
           AND c.deleted_at IS NULL
           AND c.archived_at IS NULL
           AND c.type = 'standard'
           AND c.system_channel_type IS NULL
           AND c.dm_key IS NULL
           AND p.channel_root = false
           AND p.deleted_at IS NULL
      ) AS rooms
     WHERE a.agent_kind = 'shared'
       AND a.system_managed = false
       AND a.system_slug IS NULL
       AND a.parent_agent_id IS NULL
       AND a.deleted_at IS NULL
       AND jsonb_typeof(a.tool_policy) = 'object'
       AND NOT (a.tool_policy ? 'project_operator')
       AND allowed.tools IS NOT NULL
     ORDER BY a.organization_id, a.created_at, a.id
  LOOP
    UPDATE agents
       SET tool_policy = tool_policy || '{"project_operator": true}'::jsonb
     WHERE id = granted.id;

    RAISE WARNING 'agent "%" % (organisation %) was granted project_operator because its tool policy allowed %: '
      'it keeps them only on a person''s own turn in a project channel it is in, and the grant also opens '
      'project, team, channel, board, document space and trigger setup for that person',
      granted.name, granted.id, granted.organization_id, granted.tools;

    IF granted.unattended_triggers IS NOT NULL OR granted.in_no_project_room THEN
      RAISE WARNING 'agent "%" % (organisation %) no longer reaches % where nobody is asking: %',
        granted.name, granted.id, granted.organization_id, granted.tools,
        concat_ws('; ',
          CASE WHEN granted.unattended_triggers IS NOT NULL
            THEN 'its enabled ' || granted.unattended_triggers || ' trigger fires lose them' END,
          CASE WHEN granted.in_no_project_room
            THEN 'it is in no project channel, so no turn opens them' END);
    END IF;
  END LOOP;
END $$;
