-- Board agent watchers become disabled ticket triggers
-- (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "Board watchers").
--
-- An agent watcher was a second way to configure the wake a `ticket_changed`
-- trigger is, with a different authority, and its wake landed in the adder's
-- DM with no tools. Watchers are people from here on; the API refuses an agent
-- recipient (`AGENT_WATCHERS_RETIRED`).
--
-- Summary of what this migration does, row by row:
--
-- * Every `board_watchers` row naming an agent that could still be woken (an
--   ordinary team agent, or a private agent owned by the person who added the
--   watcher) becomes ONE DISABLED `ticket_changed` trigger of that agent:
--     - named "Board watcher: <board name>", with a description saying who
--       added the watcher and that it starts no work until a person adds
--       start-work columns and instructions and enables it;
--     - follow-only: no start-work columns (`pickup: null`), the default
--       follow kinds and end columns, the default limits, no instructions;
--     - scoped to the watcher's board and project, authored by the adder
--       (`config.authorUserId`, authorship only, granting nothing);
--     - aimed at the agent's oldest live, ordinary, public channel of the
--       board's project, or at no channel when it has none — the editor then
--       asks for one before the trigger can be enabled.
-- * Every other agent row (a system agent, the Personal Assistant, or another
--   person's private agent — rows delivery already refused to wake) becomes
--   nothing.
-- * Every agent row is then deleted. People watchers are untouched.
--
-- Nobody is notified. Each row is named, with the trigger it became or why it
-- became none, in a NOTICE line that `prisma migrate deploy` and the database
-- log print. The triggers themselves list on the Triggers page, paused.

DO $$
DECLARE
  watcher RECORD;
  channel uuid;
  created uuid;
BEGIN
  FOR watcher IN
    SELECT w.id, w.board_id, w.agent_id, w.added_by_user_id,
           b.name AS board_name, b.project_id,
           a.name AS agent_name,
           (a.system_managed = false
             AND a.system_slug IS NULL
             AND a.agent_kind <> 'personal_assistant'
             AND (a.visibility = 'team'
               OR (a.visibility = 'private' AND a.owner_user_id = w.added_by_user_id))) AS eligible,
           coalesce(u.display_name, 'someone') AS adder_name
      FROM board_watchers w
      JOIN boards b ON b.id = w.board_id
      JOIN agents a ON a.id = w.agent_id
      LEFT JOIN users u ON u.id = w.added_by_user_id
     WHERE w.agent_id IS NOT NULL
     ORDER BY w.created_at, w.id
  LOOP
    IF NOT watcher.eligible THEN
      RAISE NOTICE 'board watcher % (agent "%" %, board "%" %) was not wakeable and became no trigger',
        watcher.id, watcher.agent_name, watcher.agent_id, watcher.board_name, watcher.board_id;
      CONTINUE;
    END IF;

    SELECT c.id INTO channel
      FROM agent_bindings ab
      JOIN channels c ON c.id = ab.channel_id
     WHERE ab.agent_id = watcher.agent_id
       AND c.project_id = watcher.project_id
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
       AND c.type = 'standard'
       AND c.system_channel_type IS NULL
       AND c.dm_key IS NULL
       AND c.visibility = 'public'
     ORDER BY ab.created_at, c.id
     LIMIT 1;

    INSERT INTO agent_triggers (
      id, agent_id, type, status, enabled, name, description, config,
      target_channel_id, scope_project_id, scope_board_id, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      watcher.agent_id,
      'ticket_changed',
      'paused',
      false,
      'Board watcher: ' || watcher.board_name,
      'Moved here from a board watcher ' || watcher.adder_name || ' added. It starts no work until '
        || 'someone adds start-work columns and instructions and enables it.',
      jsonb_build_object(
        'boardId', watcher.board_id,
        'pickup', NULL,
        'follow', jsonb_build_object(
          'kinds', jsonb_build_array('comment', 'description', 'moved', 'thread_message', 'document'),
          'includeSourceEvents', false
        ),
        'endOn', jsonb_build_array(
          jsonb_build_object('category', 'todo'),
          jsonb_build_object('category', 'done')
        ),
        'limits', jsonb_build_object('wakesPerTicket', 30, 'startsPerDay', 20),
        'authorUserId', watcher.added_by_user_id
      ),
      channel,
      watcher.project_id,
      watcher.board_id,
      now(),
      now()
    )
    RETURNING id INTO created;

    RAISE NOTICE 'board watcher % (agent "%" %, board "%" %) became disabled ticket trigger % "Board watcher: %"%',
      watcher.id, watcher.agent_name, watcher.agent_id, watcher.board_name, watcher.board_id,
      created, watcher.board_name,
      CASE WHEN channel IS NULL THEN ' with no channel yet' ELSE '' END;
  END LOOP;

  DELETE FROM board_watchers WHERE agent_id IS NOT NULL;
END $$;
