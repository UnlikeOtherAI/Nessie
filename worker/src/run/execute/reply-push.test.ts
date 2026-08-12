import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { enqueueInteractiveReplyPush } from './reply-push.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000002'
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000003'
const THREAD_ID = '00000000-0000-4000-8000-000000000004'
const MESSAGE_ID = '00000000-0000-4000-8000-000000000005'

const context = {
  channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID },
  run: { id: 'run-1', threadId: THREAD_ID },
} as RunContext

const payload = (input: { interactive?: boolean; effectiveUserId?: string } = {}) => ({
  actorContext: {
    actor: { actorId: USER_ID, actorType: 'user' },
    actionContext: {
      requestId: 'request-1',
      ...(input.effectiveUserId ? { effectiveUserId: input.effectiveUserId } : {}),
    },
    tenant: { organizationId: ORGANIZATION_ID },
  },
  interactive: input.interactive,
} as unknown as RunExecuteJobPayload)

const queuedPayload = (calls: unknown[]): Record<string, unknown> => {
  assert.equal(calls.length, 1)
  const values = (calls[0] as { values?: unknown[] }).values ?? []
  const encoded = values.find((value): value is string =>
    typeof value === 'string' && value.includes('recipientUserIds'),
  )
  assert.ok(encoded)
  return JSON.parse(encoded) as Record<string, unknown>
}

const queuedIdempotencyKey = (call: unknown): string | undefined =>
  ((call as { values?: unknown[] }).values ?? []).find(
    (value): value is string => typeof value === 'string' && value.startsWith('push:reply:'),
  )

test('queues an interactive reply only for the requesting user', async () => {
  const calls: unknown[] = []
  const deps = {
    prisma: { $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    } },
  } as unknown as Pick<ExecutionDependencies, 'prisma'>

  await enqueueInteractiveReplyPush(deps, payload({ interactive: true }), context, {
    content: 'The requested answer.',
    id: MESSAGE_ID,
  })

  const queued = queuedPayload(calls)
  assert.deepEqual(queued.recipientUserIds, [USER_ID])
  assert.equal(queued.channelId, CHANNEL_ID)
  assert.equal(queued.threadId, THREAD_ID)
  assert.equal(queued.messageId, MESSAGE_ID)
})

test('uses the acting effective user for an interactive delegated turn', async () => {
  const calls: unknown[] = []
  const effectiveUserId = '00000000-0000-4000-8000-000000000099'
  const deps = {
    prisma: { $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    } },
  } as unknown as Pick<ExecutionDependencies, 'prisma'>

  await enqueueInteractiveReplyPush(
    deps,
    payload({ effectiveUserId, interactive: true }),
    context,
    { content: 'Delegated answer.', id: MESSAGE_ID },
  )

  assert.deepEqual(queuedPayload(calls).recipientUserIds, [effectiveUserId])
})

test('uses one idempotency key for every terminal message from the same run', async () => {
  const calls: unknown[] = []
  const deps = {
    prisma: { $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    } },
  } as unknown as Pick<ExecutionDependencies, 'prisma'>

  await enqueueInteractiveReplyPush(deps, payload({ interactive: true }), context, {
    content: 'First terminal message.',
    id: MESSAGE_ID,
  })
  await enqueueInteractiveReplyPush(deps, payload({ interactive: true }), context, {
    content: 'Fallback terminal message.',
    id: '00000000-0000-4000-8000-000000000006',
  })

  assert.deepEqual(calls.map(queuedIdempotencyKey), ['push:reply:run-1', 'push:reply:run-1'])
})

test('does not notify for background automation', async () => {
  const calls: unknown[] = []
  const deps = {
    prisma: { $executeRaw: async (query: unknown) => {
      calls.push(query)
      return 1
    } },
  } as unknown as Pick<ExecutionDependencies, 'prisma'>

  await enqueueInteractiveReplyPush(deps, payload(), context, {
    content: 'Scheduled update.',
    id: MESSAGE_ID,
  })

  assert.deepEqual(calls, [])
})
