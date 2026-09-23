import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ColumnEnteredTaskEventPayloadSchema,
  CreatedTaskEventPayloadSchema,
  PriorityChangedTaskEventPayloadSchema,
  TaskEventAuthorshipSchema,
  TaskEventOriginSchema,
} from '../task-events.js'

const USER = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const AGENT = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const RUN = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'
const SOURCE = '3e9f4f5d-6071-4283-9d94-a5b6cd7e8f90'
const FROM = '4fa05a6e-7182-4394-8ea5-b6c7de8f9a01'
const TO = '5ab16b7f-8293-44a5-9fb6-c7d8ef9a0b12'

test('each origin door parses with exactly its own fields', () => {
  const origins = [
    { kind: 'session' },
    { kind: 'token', keyId: 'key_live_42' },
    { kind: 'agent', agentId: AGENT, runId: RUN },
    { kind: 'source', boardSourceId: SOURCE },
    { kind: 'system' },
  ]
  for (const origin of origins) {
    assert.deepEqual(TaskEventOriginSchema.parse(origin), origin)
  }
})

test('an origin outside the allowlist, or smuggling another door\'s field, is refused', () => {
  const refused = [
    {},
    { kind: 'person' },
    { kind: 'session', agentId: AGENT },
    { kind: 'session', userId: USER },
    { kind: 'system', runId: RUN },
    { kind: 'token' },
    { kind: 'token', keyId: '' },
    { kind: 'agent' },
    // An agent writes only from inside a run, so its origin always names it.
    { kind: 'agent', agentId: AGENT },
    { kind: 'agent', agentId: 'not-a-uuid', runId: RUN },
    { kind: 'agent', agentId: AGENT, runId: 'not-a-uuid' },
    { kind: 'source' },
    'session',
    `agent:${AGENT}`,
  ]
  for (const origin of refused) {
    assert.equal(TaskEventOriginSchema.safeParse(origin).success, false, JSON.stringify(origin))
  }
})

test('column_entered carries both columns, and a first placement has no from column', () => {
  const moved = {
    by: USER,
    fromColumnId: FROM,
    toColumnId: TO,
    origin: { kind: 'session' },
  }
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(moved), moved)

  const placed = { ...moved, fromColumnId: null }
  assert.deepEqual(ColumnEnteredTaskEventPayloadSchema.parse(placed), placed)

  assert.equal(ColumnEnteredTaskEventPayloadSchema.safeParse({ ...moved, toColumnId: undefined }).success, false)
  assert.equal(ColumnEnteredTaskEventPayloadSchema.safeParse({ ...moved, origin: undefined }).success, false)
})

test('column_entered is a change of column, never a reorder within one', () => {
  const result = ColumnEnteredTaskEventPayloadSchema.safeParse({
    by: USER,
    fromColumnId: TO,
    toColumnId: TO,
    origin: { kind: 'session' },
  })
  assert.equal(result.success, false)
  assert.deepEqual(result.error?.issues.map((issue) => issue.path.join('.')), ['toColumnId'])
})

test('priority_changed carries the two priorities and refuses a non-change', () => {
  const changed = { by: USER, from: 'high', to: 'urgent', origin: { kind: 'session' } }
  assert.deepEqual(PriorityChangedTaskEventPayloadSchema.parse(changed), changed)

  assert.equal(PriorityChangedTaskEventPayloadSchema.safeParse({ ...changed, to: 'high' }).success, false)
  assert.equal(PriorityChangedTaskEventPayloadSchema.safeParse({ ...changed, to: 'critical' }).success, false)
})

test('a session or token origin names the member it authenticated', () => {
  for (const schema of [ColumnEnteredTaskEventPayloadSchema, PriorityChangedTaskEventPayloadSchema]) {
    const change = schema === ColumnEnteredTaskEventPayloadSchema
      ? { fromColumnId: FROM, toColumnId: TO }
      : { from: 'low', to: 'medium' }
    for (const origin of [{ kind: 'session' }, { kind: 'token', keyId: 'key_live_42' }]) {
      assert.equal(schema.safeParse({ ...change, by: USER, origin }).success, true)
      const unnamed = schema.safeParse({ ...change, origin })
      assert.equal(unnamed.success, false, `${origin.kind} without by`)
      assert.deepEqual(unnamed.error?.issues.map((issue) => issue.path.join('.')), ['by'])
      // `agent:<id>` is how an unattended agent is credited; it is never a person.
      assert.equal(schema.safeParse({ ...change, by: `agent:${AGENT}`, origin }).success, false)
    }
  }
})

test('agent, source and system origins are credited as their writers credit them', () => {
  const change = { fromColumnId: FROM, toColumnId: TO }
  const accepted = [
    // An unattended agent run, and a personal assistant acting as its person.
    { by: `agent:${AGENT}`, origin: { kind: 'agent', agentId: AGENT, runId: RUN } },
    { by: USER, origin: { kind: 'agent', agentId: AGENT, runId: RUN } },
    // A source sync credits its source (board-source-apply.ts); the platform
    // has nobody behind it.
    { by: `source:${SOURCE}`, origin: { kind: 'source', boardSourceId: SOURCE } },
    { origin: { kind: 'source', boardSourceId: SOURCE } },
    { origin: { kind: 'system' } },
  ]
  for (const authorship of accepted) {
    assert.equal(
      ColumnEnteredTaskEventPayloadSchema.safeParse({ ...change, ...authorship }).success,
      true,
      JSON.stringify(authorship),
    )
  }
})

test('an author that disagrees with its origin is refused', () => {
  const change = { fromColumnId: FROM, toColumnId: TO }
  const agent = { kind: 'agent', agentId: AGENT, runId: RUN }
  const refused = [
    // Another agent's credit, a source's, or none at all on an agent's write.
    { by: `agent:${RUN}`, origin: agent },
    { by: `source:${SOURCE}`, origin: agent },
    { origin: agent },
    // A source credited as a member, or as another source.
    { by: USER, origin: { kind: 'source', boardSourceId: SOURCE } },
    { by: `source:${FROM}`, origin: { kind: 'source', boardSourceId: SOURCE } },
  ]
  for (const authorship of refused) {
    const result = ColumnEnteredTaskEventPayloadSchema.safeParse({ ...change, ...authorship })
    assert.equal(result.success, false, JSON.stringify(authorship))
    assert.deepEqual(result.error?.issues.map((issue) => issue.path.join('.')), ['by'])
  }
})

test('any dispatched event\'s authorship parses alone, keeping its own fields', () => {
  const comment = { by: USER, origin: { kind: 'session' }, commentId: TO }
  assert.deepEqual(TaskEventAuthorshipSchema.parse(comment), comment)
  // The same author-matches-origin rule: an agent's write never reads as a session.
  assert.equal(TaskEventAuthorshipSchema.safeParse({ by: `agent:${AGENT}`, origin: { kind: 'session' } }).success, false)
  // An event written before origins existed has none, and parses as nothing.
  assert.equal(TaskEventAuthorshipSchema.safeParse({ by: USER }).success, false)
})

test('created names the board and column the ticket landed in, or null for neither', () => {
  const created = { by: USER, origin: { kind: 'session' }, boardId: FROM, columnId: TO, assigneeUserId: null }
  assert.deepEqual(CreatedTaskEventPayloadSchema.parse(created), created)
  const projectless = { origin: { kind: 'system' }, boardId: null, columnId: null }
  assert.deepEqual(CreatedTaskEventPayloadSchema.parse(projectless), projectless)
  assert.equal(CreatedTaskEventPayloadSchema.safeParse({ by: USER, origin: { kind: 'session' } }).success, false)
})
