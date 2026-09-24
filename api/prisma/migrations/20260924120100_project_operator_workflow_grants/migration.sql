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
-- live person's own turn in a project channel it is bound to — with the
-- explicit `project_operator` grant. The Personal Assistant and the Agent
-- Designer keep them through their own arms and need no grant.
--
-- So that nothing set up on purpose silently stops working, every ordinary
-- shared agent whose tool policy names one of those five tools `true` is
-- granted `project_operator` explicitly. An agent that held them only by
-- default (no key) is granted nothing: the default was the hazard. An explicit
-- `false` stays a denial, a deleted agent is left alone, and an agent whose
-- policy already names `project_operator` either way keeps its verdict.
--
-- Each agent granted is named, with its organisation and the tools that
-- earned the grant, in a WARNING line: WARNING rather than NOTICE because
-- Postgres's default `log_min_messages` is `warning`, so the line lands in the
-- database server's log where an operator can read it afterwards. The grant
-- then shows on each agent's Tools page as "Project operator", where its owner
-- can take it back.

DO $$
DECLARE
  granted RECORD;
BEGIN
  FOR granted IN
    SELECT a.id, a.name, a.organization_id, allowed.tools
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
     WHERE a.agent_kind = 'shared'
       AND a.system_managed = false
       AND a.system_slug IS NULL
       AND a.deleted_at IS NULL
       AND jsonb_typeof(a.tool_policy) = 'object'
       AND NOT (a.tool_policy ? 'project_operator')
       AND allowed.tools IS NOT NULL
     ORDER BY a.organization_id, a.created_at, a.id
  LOOP
    UPDATE agents
       SET tool_policy = tool_policy || '{"project_operator": true}'::jsonb
     WHERE id = granted.id;

    RAISE WARNING 'agent "%" % (organisation %) was granted project_operator explicitly: its tool policy allowed %',
      granted.name, granted.id, granted.organization_id, granted.tools;
  END LOOP;
END $$;
