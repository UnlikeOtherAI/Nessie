import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { TicketChangedStoredConfigSchema, type TaskEventOrigin } from '@nessie/schemas'

import {
  decideTicketTrigger,
  endColumnIds,
  originRuleRefusal,
  type TicketEventFacts,
  type TicketTriggerFacts,
  type TicketWorkFacts,
} from '../src/control/ticket-trigger-decision.js'

// The dispatch rule of docs/plans/2026-09-23-ticket-driven-agents/triggers.md
// ("Who starts work", "Dispatch"), pinned branch by branch over plain facts.

const AGENT = randomUUID()
const OTHER_AGENT = randomUUID()
const RUN = randomUUID()
const WORK = randomUUID()
const columns = {
  backlog: randomUUID(),
  inProgress: randomUUID(),
  doing: randomUUID(),
  review: randomUUID(),
  done: randomUUID(),
}
const boardColumns: TicketTriggerFacts['columns'] = [
  { id: columns.backlog, category: 'todo' },
  { id: columns.inProgress, category: 'in_progress' },
  { id: columns.doing, category: 'in_progress' },
  { id: columns.review, category: 'review' },
  { id: columns.done, category: 'done' },
]

const trigger = (config: Record<string, unknown> = {}): TicketTriggerFacts => ({
  agentId: AGENT,
  columns: boardColumns,
  config: TicketChangedStoredConfigSchema.parse({
    boardId: randomUUID(),
    pickup: { columnIds: [columns.inProgress, columns.doing] },
    ...config,
  }),
})

const SESSION: TaskEventOrigin = { kind: 'session' }
const origins: Record<string, TaskEventOrigin> = {
  agent: { kind: 'agent', agentId: OTHER_AGENT, runId: RUN },
  token: { kind: 'token', keyId: 'cred-1' },
  source: { kind: 'source', boardSourceId: randomUUID() },
  system: { kind: 'system' },
}

const move = (to: string, over: Partial<TicketEventFacts> = {}): TicketEventFacts => ({
  eventType: 'column_entered',
  origin: SESSION,
  authorCanEditBoard: true,
  toColumnId: to,
  fromColumnId: columns.backlog,
  ...over,
})

const event = (eventType: TicketEventFacts['eventType'], over: Partial<TicketEventFacts> = {}): TicketEventFacts => ({
  eventType,
  origin: SESSION,
  authorCanEditBoard: true,
  toColumnId: null,
  fromColumnId: null,
  ...over,
})

const work = (status: TicketWorkFacts['status'] = 'active', live = true): TicketWorkFacts =>
  ({ id: WORK, status, live })

test('a board editor\'s own move into a start-work column picks the ticket up', () => {
  assert.deepEqual(decideTicketTrigger(move(columns.inProgress), trigger(), null), {
    kind: 'pickup', source: 'pickup', wakeReason: 'pickup',
  })
})

test('an agent, a token, a source and the platform never start work, and each says why', () => {
  const expected = { agent: 'agent_origin', token: 'token_origin', source: 'source_origin', system: 'system_origin' }
  for (const [name, origin] of Object.entries(origins)) {
    for (const facts of [
      move(columns.inProgress, { origin, authorCanEditBoard: false }),
      // A create straight into the column is the same decision as a move there.
      event('created', { origin, authorCanEditBoard: false, toColumnId: columns.inProgress }),
    ]) {
      assert.deepEqual(decideTicketTrigger(facts, trigger({ follow: { includeSourceEvents: true } }), null), {
        kind: 'skip', source: 'pickup', reason: expected[name as keyof typeof expected],
      }, `${name} ${facts.eventType}`)
    }
  }
})

test('a person who cannot edit the board starts nothing either', () => {
  assert.deepEqual(decideTicketTrigger(move(columns.inProgress, { authorCanEditBoard: false }), trigger(), null), {
    kind: 'skip', source: 'pickup', reason: 'not_board_editor',
  })
})

test('a board editor creating a ticket straight into a start-work column picks it up; elsewhere, nothing', () => {
  const pickup = trigger({ pickup: { columnIds: [columns.backlog] } })
  assert.equal(decideTicketTrigger(event('created', { toColumnId: columns.backlog }), pickup, null).kind, 'pickup')
  assert.equal(decideTicketTrigger(event('created', { toColumnId: columns.backlog }), trigger(), null).kind, 'ignore')
  assert.equal(decideTicketTrigger(event('created', { toColumnId: null }), pickup, null).kind, 'ignore')
})

test('moving between two start-work columns is not entering the set', () => {
  assert.deepEqual(
    decideTicketTrigger(move(columns.doing, { fromColumnId: columns.inProgress }), trigger(), null),
    { kind: 'skip', source: 'pickup', reason: 'already_in_pickup_column' },
  )
})

test('re-entry is a follow on the same record, never a second pickup', () => {
  for (const status of ['parked', 'active', 'queued', 'waiting_machine'] as const) {
    assert.deepEqual(decideTicketTrigger(move(columns.inProgress), trigger(), work(status)), {
      kind: 'reentry', source: 'follow', workId: WORK, wakeReason: 'ticket_moved',
    }, status)
  }
})

test('a re-entry that fails the origin rule leaves the record alone, a source included', () => {
  for (const origin of Object.values(origins)) {
    const decision = decideTicketTrigger(
      move(columns.inProgress, { origin, authorCanEditBoard: false }),
      trigger({ follow: { includeSourceEvents: true } }),
      work('parked'),
    )
    assert.equal(decision.kind, 'skip', origin.kind)
    // It says the work did not *resume*, which the ticket tells its readers.
    assert.equal(decision.kind === 'skip' && decision.reentry, true, origin.kind)
  }
})

test('moving live work between two start-work columns is an ordinary move, not a re-entry', () => {
  const within = move(columns.doing, { fromColumnId: columns.inProgress })
  assert.deepEqual(decideTicketTrigger(within, trigger(), work('active')), {
    kind: 'follow', source: 'follow', workId: WORK, wakeReason: 'ticket_moved', untrusted: false,
  })
  // A trigger that does not follow moves is not woken by it at all.
  assert.equal(
    decideTicketTrigger(within, trigger({ follow: { kinds: ['comment'] } }), work('active')).kind,
    'ignore',
  )
})

test('entering an end column wakes the agent once, machine-less, unless it moved the ticket itself', () => {
  for (const origin of [SESSION, origins.token!, origins.agent!, origins.system!]) {
    assert.deepEqual(decideTicketTrigger(move(columns.done, { origin }), trigger(), work('active')), {
      kind: 'end', source: 'follow', workId: WORK, wakeReason: 'ticket_moved',
    }, origin.kind)
  }
  // The record the move just ended still gets its one comment wake.
  assert.equal(decideTicketTrigger(move(columns.done), trigger(), work('done', false)).kind, 'end')
  const own = { kind: 'agent', agentId: AGENT, runId: RUN } as const
  assert.deepEqual(decideTicketTrigger(move(columns.done, { origin: own }), trigger(), work()), {
    kind: 'skip', source: 'follow', reason: 'own_agent_event',
  })
  // No work on the ticket: an end column means nothing to this trigger.
  assert.equal(decideTicketTrigger(move(columns.done), trigger(), null).kind, 'ignore')
})

test('end columns resolve by category and by id; an end column never starts work', () => {
  const byId = trigger({ endOn: [{ id: columns.review }] })
  assert.deepEqual([...endColumnIds(byId.config, boardColumns)], [columns.review])
  assert.deepEqual(
    [...endColumnIds(trigger().config, boardColumns)].sort(),
    [columns.backlog, columns.done].sort(),
  )
  const overlapping = trigger({ pickup: { columnIds: [columns.done] } })
  assert.equal(decideTicketTrigger(move(columns.done), overlapping, null).kind, 'ignore')
})

test('each followed kind wakes live work with its own reason; an unfollowed kind is ignored', () => {
  const all = trigger({
    follow: { kinds: ['comment', 'description', 'moved', 'priority', 'labels', 'assignee'] },
  })
  const cases = [
    [event('comment_added'), 'ticket_commented'],
    [event('detail_edited'), 'ticket_description_changed'],
    [event('priority_changed'), 'ticket_priority_changed'],
    [event('labels_changed'), 'ticket_labels_changed'],
    [event('assigned'), 'ticket_assignee_changed'],
    [event('unassigned'), 'ticket_assignee_changed'],
    [move(columns.review, { fromColumnId: columns.inProgress }), 'ticket_moved'],
  ] as const
  for (const [facts, wakeReason] of cases) {
    assert.deepEqual(decideTicketTrigger(facts, all, work()), {
      kind: 'follow', source: 'follow', workId: WORK, wakeReason, untrusted: false,
    }, facts.eventType)
  }
  // The defaults follow neither priority nor labels nor assignee.
  for (const eventType of ['priority_changed', 'labels_changed', 'assigned'] as const) {
    assert.equal(decideTicketTrigger(event(eventType), trigger(), work()).kind, 'ignore', eventType)
  }
  // No live work: nothing to follow.
  assert.equal(decideTicketTrigger(event('comment_added'), all, null).kind, 'ignore')
  assert.equal(decideTicketTrigger(event('comment_added'), all, work('done', false)).kind, 'ignore')
})

test('only a board editor\'s own event steers work; agents and tokens never do', () => {
  for (const [origin, reason] of [
    [origins.agent!, 'agent_origin'],
    [origins.token!, 'token_origin'],
    [origins.system!, 'system_origin'],
  ] as const) {
    assert.deepEqual(
      decideTicketTrigger(event('comment_added', { origin, authorCanEditBoard: false }), trigger(), work()),
      { kind: 'skip', source: 'follow', reason },
    )
  }
  assert.deepEqual(
    decideTicketTrigger(event('comment_added', { authorCanEditBoard: false }), trigger(), work()),
    { kind: 'skip', source: 'follow', reason: 'not_board_editor' },
  )
})

test('a source event wakes live work only when the trigger opts in, and then as untrusted', () => {
  const sourced = event('comment_added', { origin: origins.source!, authorCanEditBoard: false })
  assert.deepEqual(decideTicketTrigger(sourced, trigger(), work()), {
    kind: 'skip', source: 'follow', reason: 'source_origin',
  })
  assert.deepEqual(decideTicketTrigger(sourced, trigger({ follow: { includeSourceEvents: true } }), work()), {
    kind: 'follow', source: 'follow', workId: WORK, wakeReason: 'ticket_commented', untrusted: true,
  })
})

test('a priority change on a queued ticket wakes nothing', () => {
  const priority = trigger({ follow: { kinds: ['priority'] } })
  assert.deepEqual(decideTicketTrigger(event('priority_changed'), priority, work('queued')), {
    kind: 'skip', source: 'follow', reason: 'priority_while_queued',
  })
  assert.equal(decideTicketTrigger(event('priority_changed'), priority, work('active')).kind, 'follow')
})

test('the origin rule admits a source only where the caller allows it', () => {
  const source = { origin: origins.source!, authorCanEditBoard: false }
  assert.equal(originRuleRefusal(source, { admitSource: true }), null)
  assert.equal(originRuleRefusal(source, { admitSource: false }), 'source_origin')
  assert.equal(originRuleRefusal({ origin: SESSION, authorCanEditBoard: true }, { admitSource: false }), null)
})

test('a comment that answers the agent\'s open question wakes its work even when comments are not followed', () => {
  const movesOnly = trigger({ follow: { kinds: ['moved'] } })
  // Not an answer: an unfollowed kind stays ignored.
  assert.equal(decideTicketTrigger(event('comment_added'), movesOnly, work()).kind, 'ignore')
  assert.deepEqual(decideTicketTrigger(event('comment_added', { answeredWorkIds: [WORK] }), movesOnly, work()), {
    kind: 'follow', source: 'follow', workId: WORK, wakeReason: 'ticket_commented', untrusted: false,
  })
  // Another record's question is not this one's.
  assert.equal(
    decideTicketTrigger(event('comment_added', { answeredWorkIds: [randomUUID()] }), movesOnly, work()).kind,
    'ignore',
  )
  // The origin rule still holds: a reply from someone who cannot edit the board wakes nothing.
  assert.deepEqual(
    decideTicketTrigger(
      event('comment_added', { answeredWorkIds: [WORK], authorCanEditBoard: false }),
      movesOnly,
      work(),
    ),
    { kind: 'skip', source: 'follow', reason: 'not_board_editor' },
  )
})
