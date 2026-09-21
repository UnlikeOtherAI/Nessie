import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, TaskSetDisclosure } from '@nessie/schemas'
import { mergeTaskSetDisclosure } from '../src/task-set-disclosure.js'
import { getTaskSetItemForActor, listTaskSetItemsForActor } from '../src/task-set-read.js'
import { appendTaskSetItems } from '../src/task-set-items.js'

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
const [organizationId, userId, setId, itemId, channelId, authorId]
  = ids as [string, string, string, string, string, string]
const basis = (scopeType: string, scopeId: string): TaskSetDisclosure => ({
  classified: true, basisScopes: [{ scopeType, scopeId }], disclosureSources: [],
})
const owner = basis('user', userId)
const input = basis('channel', channelId)
const result: TaskSetDisclosure = { ...input,
  disclosureSources: [{ sourceChannelId: channelId, sourceAuthorUserId: authorId }],
}
const item = {
  id: itemId, taskSetId: setId, sequence: 1, prompt: 'Summarise the row', input: {}, dependencies: [],
  status: 'completed', createdAt: new Date(), statusChangedAt: new Date(), attempts: 1,
  reason: null, result: 'A finding', outputPageId: null, sourceLocator: 'row 125',
  disclosure: input, resultDisclosure: result,
}
const actor = {
  actor: { actorType: 'agent', actorId: authorId }, tenant: { organizationId },
  actionContext: { effectiveUserId: userId, requestId: 'task-set-disclosure' },
} as AuthorizedActionContext

// Every queried identity delegate is explicit: no permissive Proxy hides a changed query.
const reader = (channels = [channelId]) => ({
  organization: { findUnique: async () => ({ externalOrgId: null }) },
  organizationMember: { findFirst: async () => ({ id: userId }) },
  channelMember: { findMany: async () => channels.map((id) => ({ channelId: id })) },
  teamMember: { findMany: async () => [] }, projectMember: { findMany: async () => [] },
  agent: { findMany: async () => [] },
  taskSet: { findFirst: async () => ({ id: setId, disclosure: owner, totalItems: 1 }) },
  taskSetItem: { findFirst: async () => item, findMany: async () => [item] },
}) as unknown as PrismaClient

test('task-set disclosure union retains exact authors and unknown-author denial markers', () => {
  const unknown = { ...input, disclosureSources: [{ sourceChannelId: channelId, sourceAuthorUserId: null }] }
  const combined = mergeTaskSetDisclosure(owner, input, result, unknown, input, undefined)
  assert.deepEqual(combined.basisScopes, [...owner.basisScopes, ...input.basisScopes])
  assert.deepEqual(combined.disclosureSources, [...result.disclosureSources, ...unknown.disclosureSources])
  assert.throws(() => mergeTaskSetDisclosure(owner, null), /Expected object/)
  assert.throws(() => mergeTaskSetDisclosure(owner, { classified: false }), /Invalid literal/)
})

test('task-set item readers observe set, input and result before returning their contents', async () => {
  for (const read of [getTaskSetItemForActor, async (
    prisma: PrismaClient, context: AuthorizedActionContext, id: string, _itemId: string,
    observe: (value: TaskSetDisclosure) => void,
  ) => listTaskSetItemsForActor(prisma, context, id, {}, observe)]) {
    const observed: TaskSetDisclosure[] = []
    await read(reader(), actor, setId, itemId, (value) => observed.push(value))
    assert.deepEqual(observed, [owner, input, result])
  }
})

test('task-set result access never replaces the narrower input boundary', async () => {
  const prisma = reader([])
  prisma.taskSetItem.findFirst = (async () => ({ ...item, resultDisclosure: owner })) as never
  prisma.taskSetItem.findMany = (async () => [{ ...item, resultDisclosure: owner }]) as never
  await assert.rejects(getTaskSetItemForActor(prisma, actor, setId, itemId), /no longer read a source/)
  await assert.rejects(listTaskSetItemsForActor(prisma, actor, setId), /no longer read a source/)
})

test('task-set idempotent append retains additional trusted lineage without another task', async () => {
  let saved: unknown
  let count = 1
  const tx = {
    $queryRaw: async () => [],
    taskSet: {
      findUniqueOrThrow: async () => ({ status: 'draft', totalItems: count, inputClosedAt: null, source: null }),
      update: async ({ data }: { data: { totalItems: number } }) => { count = data.totalItems },
    },
    taskSetItem: {
      findUnique: async () => ({ ...item, disclosure: owner }),
      update: async ({ data }: { data: { disclosure: unknown } }) => { saved = data.disclosure; return item },
    },
  }
  const added = await appendTaskSetItems(tx as never, setId, [{ clientKey: 'row125', prompt: item.prompt, input: {} }], result)
  assert.equal(added.length, 1)
  assert.equal(count, 1)
  assert.deepEqual(saved, mergeTaskSetDisclosure(owner, result))
})
