import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentKeys,
  agentTodoKeys,
  appKeys,
  channelKeys,
  dashboardKeys,
  knowledgeKeys,
  projectKeys,
  taskKeys,
  threadKeys,
  triggerKeys,
  userKeys,
  workflowKeys,
} from '../src/lib/query-keys.js'

// A key is cache identity, so a factory that emits anything but the array the
// call sites used before this module existed silently orphans a cache entry.
// Most of these assertions are those literals verbatim. The exceptions are the
// orphan prefixes this module deliberately re-nested — project members, the
// project board, dashboard widget data, and knowledge backlinks/mentions —
// which changed shape precisely so their parent's invalidation reaches them;
// each is asserted here in its new form and reasoned about at its declaration.
test('channel keys keep the arrays the call sites used', () => {
  assert.deepEqual(channelKeys.all, ['channels'])
  assert.deepEqual(
    channelKeys.messageSearch('ch-1', 'budget'),
    ['channels', 'ch-1', 'messages', 'search', 'budget'],
  )
})

test('agent keys keep the arrays the call sites used', () => {
  assert.deepEqual(agentKeys.all, ['agents'])
  assert.deepEqual(agentKeys.allScopes, ['agents', 'all'])
  assert.deepEqual(agentKeys.models, ['agents', 'models'])
  assert.deepEqual(agentKeys.status('a-1'), ['agents', 'a-1', 'status'])
  assert.deepEqual(agentKeys.activity('a-1'), ['agents', 'a-1', 'activity'])
  assert.deepEqual(agentKeys.children('a-1'), ['agents', 'a-1', 'children'])
  assert.deepEqual(agentKeys.messages('a-1'), ['agents', 'a-1', 'messages'])
  assert.deepEqual(
    agentKeys.messagePage('a-1', 25, 50),
    ['agents', 'a-1', 'messages', 25, 50],
  )
  assert.deepEqual(agentKeys.triggers('a-1'), ['agents', 'a-1', 'triggers'])
  assert.deepEqual(agentKeys.triggers(undefined), ['agents', undefined, 'triggers'])
  assert.deepEqual(agentTodoKeys.instances('a-1'), ['agents', 'a-1', 'todos'])
  assert.deepEqual(
    agentTodoKeys.templates('a-1', true),
    ['agents', 'a-1', 'todo-templates', true],
  )
  assert.deepEqual(
    agentKeys.runTools('a-1', 'r-1'),
    ['agents', 'a-1', 'runs', 'r-1', 'tools'],
  )
})

test('thread keys keep the arrays the call sites used', () => {
  assert.deepEqual(threadKeys.unreadDirectMessages, ['threads', 'unread-direct-messages'])
  assert.deepEqual(threadKeys.messages('t-1'), ['threads', 't-1', 'messages'])
  assert.deepEqual(threadKeys.replies('t-1'), ['threads', 't-1', 'replies'])
  assert.deepEqual(
    threadKeys.repliesOf('t-1', 'm-1'),
    ['threads', 't-1', 'replies', 'm-1'],
  )
  assert.deepEqual(
    threadKeys.message('t-1', 'm-1'),
    ['threads', 't-1', 'message', 'm-1'],
  )
  assert.deepEqual(
    threadKeys.runThinking('t-1', 'r-1'),
    ['threads', 't-1', 'runs', 'r-1', 'thinking'],
  )
  assert.deepEqual(
    threadKeys.documentStreams('t-1'),
    ['threads', 't-1', 'documentStreams'],
  )
  assert.deepEqual(
    threadKeys.documentStream('t-1', 's-1'),
    ['threads', 't-1', 'documentStreams', 's-1'],
  )
})

test('user and project roots keep their arrays', () => {
  assert.deepEqual(userKeys.all, ['users'])
  assert.deepEqual(projectKeys.all, ['projects'])
})

// The two prefixes the module states as exceptions to rule 1: nesting them
// would make a parent invalidation re-run work nobody asked for, so they stay
// unreachable from `projects`/`tasks` on purpose.
test('the documented exceptions stay outside their parent root', () => {
  assert.deepEqual(projectKeys.insights('p-1'), ['project-insights', 'p-1'])
  assert.notDeepEqual(
    projectKeys.insights('p-1').slice(0, projectKeys.all.length),
    projectKeys.all,
  )

  assert.deepEqual(taskKeys.assignees, ['task-assignees'])
  assert.notDeepEqual(taskKeys.assignees.slice(0, taskKeys.all.length), taskKeys.all)
})

// An undefined id was part of the literal, not a reason to substitute a
// placeholder: the query is disabled, but its cache entry must still be the
// same one the enabled render produces for a real id.
test('an absent id keeps its slot rather than collapsing the key', () => {
  assert.deepEqual(threadKeys.messages(undefined), ['threads', undefined, 'messages'])
  assert.deepEqual(agentKeys.status(undefined), ['agents', undefined, 'status'])
  assert.deepEqual(
    triggerKeys.history(undefined, 10),
    ['triggers', undefined, 'history', 10],
  )
  assert.deepEqual(dashboardKeys.detail(undefined), ['dashboards', undefined])
})

// The sub-resources that used to own a root of their own, and so were
// unreachable from the mutation that refreshed their parent.
test('re-nested sub-resources sit under the prefix their parent invalidates', () => {
  assert.deepEqual(projectKeys.members('p-1'), ['projects', 'p-1', 'members'])
  assert.deepEqual(
    projectKeys.members('p-1').slice(0, projectKeys.all.length),
    projectKeys.all,
  )

  // Re-nested here: the project mutations that invalidate `projects` now also
  // refresh a mounted board.
  assert.deepEqual(projectKeys.boards('p-1'), ['projects', 'p-1', 'boards'])
  assert.deepEqual(
    projectKeys.boards('p-1').slice(0, projectKeys.all.length),
    projectKeys.all,
  )

  assert.deepEqual(dashboardKeys.widgetData('w-1'), ['dashboards', 'widget-data', 'w-1'])
  assert.deepEqual(
    dashboardKeys.widgetData('w-1').slice(0, dashboardKeys.all.length),
    dashboardKeys.all,
  )

  assert.deepEqual(
    knowledgeKeys.backlinks('pg-1'),
    ['knowledge-page', 'pg-1', 'backlinks'],
  )
  assert.deepEqual(knowledgeKeys.mentions('pg-1'), ['knowledge-page', 'pg-1', 'mentions'])
  for (const key of [knowledgeKeys.backlinks('pg-1'), knowledgeKeys.mentions('pg-1')]) {
    assert.deepEqual(key.slice(0, 2), knowledgeKeys.page('pg-1'))
  }
})

test('task and knowledge keys keep their placeholder fallbacks', () => {
  assert.deepEqual(taskKeys.all, ['tasks'])
  assert.deepEqual(taskKeys.forProject('p-1'), ['tasks', 'p-1'])
  assert.deepEqual(taskKeys.forProject(undefined), ['tasks', 'all'])
  assert.deepEqual(taskKeys.documents(undefined), ['task-pages', 'none'])
  assert.deepEqual(knowledgeKeys.page(undefined), ['knowledge-page', 'none'])
  assert.deepEqual(knowledgeKeys.pages(undefined), ['knowledge-pages', 'none'])
  assert.deepEqual(knowledgeKeys.spaces, ['knowledge-spaces'])
  assert.deepEqual(
    knowledgeKeys.scopedSpaces(undefined),
    ['knowledge-spaces', 'organization'],
  )
})

// A family root that no child is built from is a second spelling waiting to
// drift. Each of these roots is now the literal prefix its children spread.
test('a family root is the prefix its own children are built from', () => {
  assert.deepEqual(appKeys.detail('slack').slice(0, appKeys.all.length), appKeys.all)
  assert.deepEqual(appKeys.list({}).slice(0, appKeys.all.length), appKeys.all)

  for (const key of [workflowKeys.failedRuns, workflowKeys.run('wr-1')]) {
    assert.deepEqual(key.slice(0, workflowKeys.runs.length), workflowKeys.runs)
  }

  assert.deepEqual(
    dashboardKeys.widgetDataView('w-1', '?compact=true'),
    ['dashboards', 'widget-data', 'w-1', '?compact=true'],
  )
  assert.deepEqual(
    dashboardKeys.widgetDataView('w-1', '').slice(0, dashboardKeys.widgetData('w-1').length),
    dashboardKeys.widgetData('w-1'),
  )
})

// `list('')` and a disabled `detail(undefined)` both used to be ['dashboards', '']
// while being typed as different response shapes.
test('the dashboard list and detail keys cannot collide', () => {
  assert.deepEqual(dashboardKeys.list(''), ['dashboards', 'list', ''])
  assert.notDeepEqual(dashboardKeys.list(''), dashboardKeys.detail(undefined))
  assert.notDeepEqual(dashboardKeys.list(''), dashboardKeys.detail(''))
})
