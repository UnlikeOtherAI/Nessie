import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

import { AgentTriggerTypeSchema } from '../lifecycle.js'
import { describeObjectFields, listUndescribedFields } from '../schema-prose.js'
import { TicketChangedStoredConfigSchema } from '../ticket-triggers.js'
import {
  AGENT_TRIGGER_INPUT_TYPES,
  AgentTriggerConfigInputSchema,
  describeAgentTriggerType,
  describeAgentTriggerTypes,
  TICKET_QUIET_WAKE_MINUTES,
  TICKET_WAITING_MACHINE_HOURS,
  TICKET_TRIGGER_LIMIT_CEILINGS,
  TicketChangedTriggerConfigSchema,
  TicketChangedWorkConfigSchema,
} from '../trigger-configs.js'

const BOARD = '0b6f1c2a-3d4e-4f50-8a61-72839a4b5c6d'
const COLUMN = '1c7f2d3b-4e5f-4061-9b72-8394ab5c6d7e'
const CHANNEL = '2d8f3e4c-5f60-4172-8c83-94a5bc6d7e8f'

const minimal = { instructions: { general: 'Read the ticket before you act.' } }

test('the union offers every type an agent may be given', () => {
  assert.deepEqual(
    [...AGENT_TRIGGER_INPUT_TYPES],
    ['manual', 'scheduled', 'interval', 'webhook', 'event', 'ticket_changed', 'document_changed'],
  )
  for (const type of AGENT_TRIGGER_INPUT_TYPES) {
    assert.ok(AgentTriggerTypeSchema.options.includes(type), `${type} is a trigger type`)
  }
})

test('a ticket_changed config with only its instructions takes every default', () => {
  const parsed = TicketChangedTriggerConfigSchema.parse(minimal)
  assert.equal(parsed.boardId, undefined)
  assert.equal(parsed.pickup, undefined)
  assert.deepEqual(parsed.follow, {
    includeSourceEvents: false,
    kinds: ['comment', 'description', 'moved', 'thread_message', 'document'],
  })
  assert.deepEqual(parsed.endOn, [{ category: 'todo' }, { category: 'done' }])
  assert.deepEqual(parsed.limits, { startsPerDay: 20, wakesPerTicket: 30 })
})

test('a pickup column is named by id, by name or by category, and assigns on pickup by default', () => {
  const parsed = TicketChangedTriggerConfigSchema.parse({
    ...minimal,
    pickup: { columns: [{ id: COLUMN }, { name: 'In progress' }, { category: 'review' }] },
  })
  assert.deepEqual(parsed.pickup, {
    assignOnPickup: true,
    columns: [{ id: COLUMN }, { name: 'In progress' }, { category: 'review' }],
  })
  for (const column of [{ category: 'done' }, { id: COLUMN, name: 'Both' }, 'In progress', {}]) {
    const result = TicketChangedTriggerConfigSchema.safeParse({ ...minimal, pickup: { columns: [column] } })
    assert.equal(result.success, false, JSON.stringify(column))
    assert.deepEqual(result.error?.issues[0]?.path, ['pickup', 'columns', 0])
    assert.match(result.error?.issues[0]?.message ?? '', /exactly one of \{"id": …\}, \{"name": …\} or \{"category"/)
  }
})

test('the config refuses what nothing reads, and keys it does not know', () => {
  const refused = (config: Record<string, unknown>): string[] => {
    const result = TicketChangedTriggerConfigSchema.safeParse(config)
    assert.equal(result.success, false, JSON.stringify(config))
    return result.error!.issues.map((issue) => issue.path.join('.'))
  }
  assert.deepEqual(refused({}), ['instructions'])
  assert.deepEqual(refused({ instructions: { general: '  ' } }), ['instructions.general'])
  assert.deepEqual(refused({ ...minimal, pickUp: {} }), [''])
  assert.deepEqual(refused({ ...minimal, limits: { ticketUsd: 20 } }), ['limits'])
  assert.deepEqual(
    refused({ ...minimal, limits: { wakesPerTicket: TICKET_TRIGGER_LIMIT_CEILINGS.wakesPerTicket + 1 } }),
    ['limits.wakesPerTicket'],
  )
  assert.deepEqual(refused({ ...minimal, follow: { kinds: ['everything'] } }), ['follow.kinds.0'])
  assert.deepEqual(refused({ ...minimal, endOn: [{ category: 'review' }] }), ['endOn.0'])
})

test('the arm needs its target channel beside the config', () => {
  const arm = { config: minimal, type: 'ticket_changed' }
  assert.equal(AgentTriggerConfigInputSchema.safeParse(arm).success, false)
  assert.equal(AgentTriggerConfigInputSchema.safeParse({ ...arm, targetChannelId: CHANNEL }).success, true)
  // The legacy arms describe their keys; they do not refuse the ones they do not name.
  assert.equal(
    AgentTriggerConfigInputSchema.safeParse({ config: { cron: '0 9 * * 1-5', todoTemplateId: 'x' }, type: 'scheduled' }).success,
    true,
  )
})

test('the resolved form the server writes is what the dispatcher and the work record read', () => {
  const resolved = {
    boardId: BOARD,
    endOn: [{ category: 'done' }, { id: COLUMN }],
    follow: { includeSourceEvents: false, kinds: ['comment'] },
    instructions: minimal.instructions,
    limits: { startsPerDay: 5, wakesPerTicket: 10 },
    pickup: { assignOnPickup: false, columnIds: [COLUMN] },
  }
  assert.equal(TicketChangedStoredConfigSchema.safeParse(resolved).success, true)
  const work = TicketChangedWorkConfigSchema.parse(resolved)
  assert.deepEqual(work.limits, { startsPerDay: 5, wakesPerTicket: 10 })
  assert.deepEqual(work.instructions, minimal.instructions)
  // A trigger migrated from a board watcher has neither yet.
  const migrated = TicketChangedWorkConfigSchema.parse({ boardId: BOARD })
  assert.deepEqual(migrated.limits, { startsPerDay: 20, wakesPerTicket: 30 })
  assert.equal(migrated.instructions, undefined)
})

test('every field of every arm is described, nested fields and column forms included', () => {
  for (const option of AgentTriggerConfigInputSchema.options as readonly z.AnyZodObject[]) {
    const type = (option.shape['type'] as z.ZodLiteral<string>).value
    assert.deepEqual(listUndescribedFields(option.omit({ type: true })), [], type)
    assert.ok((option.shape['config'] as z.ZodTypeAny).description, `${type} says what it does`)
  }
  // The walker itself notices a field nobody described.
  assert.deepEqual(
    listUndescribedFields(z.object({ a: z.string().describe('A.'), b: z.object({ c: z.number() }) })),
    ['b', 'b.c'],
  )
})

test('the prose names each field, its shape, its default and the forms a column takes', () => {
  const lines = describeAgentTriggerType('ticket_changed')
  const text = lines.join('\n')
  assert.match(lines[0]!, /^- ticket_changed — Starts an agent's work on a ticket/)
  assert.match(text, /\n {2}- targetChannelId: id — A live, ordinary, public channel/)
  assert.match(text, /\n {4}- boardId \(optional\): id — The board whose tickets/)
  assert.match(text, /\n {2}- config: object\n/)
  assert.equal(text.match(/Starts an agent's work on a ticket/g)?.length, 1, 'what it does is said once')
  assert.match(text, /\n {6}- columns: list \(at least 1\), each one of the forms below — Start-work columns/)
  assert.match(text, /\n {8}- \{id: id\} — A column id, from project_structure_read\./)
  assert.match(text, /\n {8}- \{name: text\} — A column's name on the board/)
  assert.match(text, /\n {8}- \{category: in_progress \| review\} — Every column of this category/)
  assert.match(text, /- assignOnPickup \(optional\): true or false, default true — /)
  assert.match(text, /- kinds \(optional\): list of comment \| description \| moved/)
  assert.match(text, /default \["comment","description","moved","thread_message","document"\]/)
  assert.match(
    text,
    /- endOn \(optional\): list, each one of the forms below, default \[\{"category":"todo"\},\{"category":"done"\}\]/,
  )
  assert.match(text, /- wakesPerTicket \(optional\): whole number 1–100, default 30 — /)
  assert.match(text, /- general: text — What the agent does with every ticket/)
  assert.match(text, /- onPickup \(optional\): text — Added after general when work on a ticket starts\./)
  // A pickup may be null, which the field says.
  assert.match(text, /- pickup \(optional\): object, or null — /)

  const all = describeAgentTriggerTypes().join('\n')
  for (const type of AGENT_TRIGGER_INPUT_TYPES) assert.match(all, new RegExp(`^- ${type} — `, 'm'))
  assert.match(all, /- interval_minutes: whole number of at least 1 — Minutes between two runs\./)
  assert.match(all, /- events: list of text \(at least 1\) — The event names/)
  assert.match(all, /^- document_changed — Wakes the agent when a watched document/m)
  // The generic walker indents nested objects under their field.
  assert.deepEqual(
    describeObjectFields(z.object({ outer: z.object({ inner: z.boolean().describe('I.') }).describe('O.') })),
    ['- outer: object — O.', '  - inner: true or false — I.'],
  )
})

test('the quiet wake defaults to 30 minutes, null turns it off, and it stays within its bounds', () => {
  assert.equal(TicketChangedTriggerConfigSchema.parse(minimal).quietWakeMinutes, TICKET_QUIET_WAKE_MINUTES.default)
  assert.equal(TicketChangedTriggerConfigSchema.parse({ ...minimal, quietWakeMinutes: null }).quietWakeMinutes, null)
  assert.equal(TicketChangedTriggerConfigSchema.parse({ ...minimal, quietWakeMinutes: 45 }).quietWakeMinutes, 45)
  for (const refused of [TICKET_QUIET_WAKE_MINUTES.min - 1, TICKET_QUIET_WAKE_MINUTES.max + 1, 20.5, '30']) {
    assert.equal(
      TicketChangedTriggerConfigSchema.safeParse({ ...minimal, quietWakeMinutes: refused }).success,
      false,
      `quietWakeMinutes ${JSON.stringify(refused)} is refused`,
    )
  }
  // A stored trigger from before the option — a migrated board watcher — takes the default.
  assert.equal(TicketChangedWorkConfigSchema.parse({ boardId: BOARD }).quietWakeMinutes, 30)
  assert.equal(TicketChangedWorkConfigSchema.parse({ boardId: BOARD, quietWakeMinutes: null }).quietWakeMinutes, null)
})

test('work waits 24 hours for its own offline machine by default, within its bounds (T5)', () => {
  assert.equal(
    TicketChangedTriggerConfigSchema.parse(minimal).waitingMachineHours, TICKET_WAITING_MACHINE_HOURS.default,
  )
  assert.equal(TicketChangedTriggerConfigSchema.parse({ ...minimal, waitingMachineHours: 6 }).waitingMachineHours, 6)
  for (const refused of [0, TICKET_WAITING_MACHINE_HOURS.max + 1, 1.5, '24', null]) {
    assert.equal(
      TicketChangedTriggerConfigSchema.safeParse({ ...minimal, waitingMachineHours: refused }).success,
      false,
      `waitingMachineHours ${JSON.stringify(refused)} is refused`,
    )
  }
  // A stored trigger from before the option takes the default.
  assert.equal(TicketChangedWorkConfigSchema.parse({ boardId: BOARD }).waitingMachineHours, 24)
})
