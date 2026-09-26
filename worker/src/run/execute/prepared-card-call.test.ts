import assert from 'node:assert/strict'
import test from 'node:test'

import { runCardPostTool } from '../pa-tools/cards.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { claimPreparedCardCall, recordPreparedCardOutcome } from './prepared-card-call.js'

const CARD_ID = '0f6c1c50-4c1b-4d5e-9d40-2b7b5f7e8a01'
const AGENT_ID = '0f6c1c50-4c1b-4d5e-9d40-2b7b5f7e8a02'
const RUN_ID = '0f6c1c50-4c1b-4d5e-9d40-2b7b5f7e8a03'
const OTHER_RUN_ID = '0f6c1c50-4c1b-4d5e-9d40-2b7b5f7e8a04'
const ANSWER_ID = '0f6c1c50-4c1b-4d5e-9d40-2b7b5f7e8a05'

const book = { arguments: { day: 'friday', time: '14:00' }, tool: 'room_book' }

/** One card row, claimed the way Postgres would: only while `prepared_execution` is null. */
const cardStore = (overrides: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    agentId: AGENT_ID, id: CARD_ID, preparedActions: { friday: book }, preparedExecution: null,
    resolvedActionKey: 'friday', responseMessageId: ANSWER_ID, status: 'resolved', ...overrides,
  }
  const prisma = {
    agentCard: {
      findUnique: async ({ where }: { where: { responseMessageId: string } }) =>
        where.responseMessageId === row.responseMessageId ? { ...row } : null,
      updateMany: async ({ data, where }: { data: { preparedExecution: unknown }; where: Record<string, unknown> }) => {
        if (where.id !== row.id) return { count: 0 }
        if ('preparedExecution' in where && row.preparedExecution !== null) return { count: 0 }
        row.preparedExecution = data.preparedExecution
        return { count: 1 }
      },
    },
  }
  return { prisma: prisma as never, row }
}

const claim = (prisma: never, runId = RUN_ID, batchMessageIds?: string[]) =>
  claimPreparedCardCall(prisma, { messageId: ANSWER_ID, ...(batchMessageIds ? { batchMessageIds } : {}) }, {
    agent: { id: AGENT_ID }, run: { id: runId },
  })

test('the answer’s run takes the pressed button’s prepared call, once', async () => {
  const { prisma, row } = cardStore()
  const first = await claim(prisma)
  assert.deepEqual(first, {
    cardId: CARD_ID,
    call: {
      arguments: book.arguments,
      toolCallId: 'prepared_0f6c1c504c1b4d5e9d402b7b5f7e8a01',
      toolName: 'room_book',
    },
  })
  assert.deepEqual(row.preparedExecution, { runId: RUN_ID })

  // The same run back after a crash picks its own claim up again…
  assert.ok(await claim(prisma))
  // …but a restarted run, or any other, asks the model instead.
  assert.equal(await claim(prisma, OTHER_RUN_ID), null)

  await recordPreparedCardOutcome(prisma, first!, { preparedCompleted: true, runId: RUN_ID })
  assert.deepEqual(row.preparedExecution, { outcome: 'succeeded', runId: RUN_ID })
  assert.equal(await claim(prisma), null, 'a finished call is never run again')
})

test('nothing is prepared for a button without a call, another agent’s card, or a batch', async () => {
  assert.equal(await claim(cardStore({ resolvedActionKey: 'other' }).prisma), null)
  assert.equal(await claim(cardStore({ agentId: OTHER_RUN_ID }).prisma), null)
  assert.equal(await claim(cardStore({ status: 'open' }).prisma), null)
  assert.equal(await claim(cardStore({ preparedActions: null }).prisma), null)
  assert.equal(await claim(cardStore().prisma, RUN_ID, [ANSWER_ID, OTHER_RUN_ID]), null)
})

const card = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  title: 'Book the Aquarium room',
  blocks: [{ type: 'text', markdown: 'Which slot?' }],
  actions: [
    { key: 'thursday', label: 'Thu 10:00', style: 'primary', submits: false },
    { key: 'friday', label: 'Fri 14:00', style: 'secondary', submits: false },
  ],
  ...overrides,
})

const post = (input: Record<string, unknown>) =>
  runCardPostTool({ prisma: {} } as unknown as BuiltinToolRuntimeContext, input)

test('a prepared button is refused where the press could not make the decision whole', async () => {
  await assert.rejects(post({ card: card(), prepared: { saturday: book } }), /not one of this card/)
  await assert.rejects(post({ card: card(), prepared: { friday: book }, wait: true }), /cannot also wait/)
  await assert.rejects(post({
    card: card({
      blocks: [{ type: 'input', key: 'note', label: 'Note', input: 'text' }],
      actions: [{ key: 'friday', label: 'Fri 14:00', style: 'primary', submits: true }],
    }),
    prepared: { friday: book },
  }), /no input or secret fields/)
  await assert.rejects(post({
    card: card(), prepared: { friday: { arguments: {}, tool: 'card_post' } },
  }), /cannot post another card/)
  await assert.rejects(post({
    card: card(), prepared: { friday: { arguments: { blob: 'x'.repeat(20_000) }, tool: 'room_book' } },
  }), /too large/)
  // A valid preparation gets as far as needing the conversation.
  await assert.rejects(post({ card: card(), prepared: { friday: book } }), /current conversation/)
})
