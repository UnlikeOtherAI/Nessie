import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUN_AUTO_CONTINUATION_TOPIC,
  type RunAutoContinuationJobPayload,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { loadRunCheckpointForRun } from './checkpoint.js'
import {
  enqueueAutoContinuation,
  isInteractiveRun,
  shouldAutoContinue,
  startAutoContinuation,
} from './continuation.js'
import { resolveReplyRootMessageId } from './reply-placement.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const payload = (interactive?: boolean): RunExecuteJobPayload =>
  ({ ...(interactive === undefined ? {} : { interactive }) }) as RunExecuteJobPayload

test('only a live human turn is interactive; automation never is', () => {
  assert.equal(isInteractiveRun(payload(true)), true)
  assert.equal(isInteractiveRun(payload(false)), false)
  // Triggers, schedules, workflows and mailbox runs leave the flag unset.
  assert.equal(isInteractiveRun(payload()), false)
})

test('an interactive run never auto-continues — it stops and offers the affordance', () => {
  assert.equal(shouldAutoContinue({ generation: 1, payload: payload(true) }), false)
})

test('non-interactive runs auto-continue up to the configured generation cap', () => {
  const previous = process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  try {
    assert.equal(shouldAutoContinue({ generation: 1, payload: payload(false) }), true)
    assert.equal(shouldAutoContinue({ generation: 2, payload: payload() }), true)
    // Generation 3 is past the default cap of 2: stop terminally with the
    // checkpoint attached instead of continuing forever.
    assert.equal(shouldAutoContinue({ generation: 3, payload: payload() }), false)
    assert.equal(shouldAutoContinue({ generation: 9, payload: payload() }), false)
  } finally {
    if (previous === undefined) delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
    else process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = previous
  }
})

test('the cap is env-tunable, including fully disabled', () => {
  const previous = process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
  try {
    process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = '0'
    assert.equal(shouldAutoContinue({ generation: 1, payload: payload() }), false)
    process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = '4'
    assert.equal(shouldAutoContinue({ generation: 4, payload: payload() }), true)
    assert.equal(shouldAutoContinue({ generation: 5, payload: payload() }), false)
  } finally {
    if (previous === undefined) delete process.env['NESSIE_RUN_AUTO_CONTINUATIONS']
    else process.env['NESSIE_RUN_AUTO_CONTINUATIONS'] = previous
  }
})

test('peer continuations retain channel placement and the original requester', async () => {
  const ids = {
    agent: '00000000-0000-4000-8000-000000000001',
    channel: '00000000-0000-4000-8000-000000000002',
    human: '00000000-0000-4000-8000-000000000003',
    run: '00000000-0000-4000-8000-000000000004',
    task: '00000000-0000-4000-8000-000000000005',
    thread: '00000000-0000-4000-8000-000000000006',
    trigger: '00000000-0000-4000-8000-000000000007',
  }
  const creates: Array<Record<string, unknown>> = []
  const createdRunIds: string[] = []
  const queued: Array<{ values?: unknown[] }> = []
  const nextRunIds = [
    '00000000-0000-4000-8000-000000000008',
    '00000000-0000-4000-8000-000000000009',
  ]
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      queued.push(args[0] as { values?: unknown[] })
      return 1
    },
    run: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data)
        const id = nextRunIds.shift()
        assert.ok(id)
        createdRunIds.push(id)
        return { id }
      },
      findFirst: async () => null,
    },
    runCheckpoint: {
      findUnique: async () => ({ consumedByRunId: null }),
      updateMany: async () => ({ count: 1 }),
    },
    task: { create: async () => ({ id: '00000000-0000-4000-8000-000000000099' }) },
    taskEvent: { create: async () => ({}) },
  }
  const deps = {
    prisma: { $transaction: async <T>(work: (inner: typeof tx) => Promise<T>) => work(tx) },
  } as unknown as ExecutionDependencies
  const context = {
    agent: { id: ids.agent },
    channel: { id: ids.channel, organizationId: '00000000-0000-4000-8000-000000000010' },
    run: { id: ids.run, principalUserId: ids.human, replyPlacement: 'channel', threadId: ids.thread },
  } as unknown as RunContext
  const peerPayload = {
    actorContext: {
      actionContext: {
        effectiveUserId: ids.human,
        purpose: 'agent.peer_delegation',
        uoaIdentity: { organizationId: 'org', subject: 'subject', teamId: 'team', tokenVersion: 1 },
      },
      actor: { actorId: ids.human, actorType: 'user' },
      tenant: { organizationId: '00000000-0000-4000-8000-000000000010' },
    },
    agentId: ids.agent,
    interactive: false,
    messageId: ids.trigger,
    runId: ids.run,
    taskId: ids.task,
    threadId: ids.thread,
  } as unknown as RunExecuteJobPayload

  await enqueueAutoContinuation(deps, peerPayload, context, { checkpointId: 'checkpoint-1' })
  await enqueueAutoContinuation(deps, peerPayload, {
    ...context,
    run: { ...context.run, id: '00000000-0000-4000-8000-000000000008' },
  }, { checkpointId: 'checkpoint-2' })

  assert.equal(creates.length, 2)
  assert.ok(creates.every((data) => data.replyPlacement === 'channel'))
  // Both parts resolve top-level against the hidden brief instead of silently
  // threading their visible outcome under that private message.
  for (const created of creates) {
    assert.equal(
      resolveReplyRootMessageId(
        { id: ids.trigger, rootMessageId: null },
        null,
        created.replyPlacement as 'channel',
      ),
      undefined,
    )
  }

  const queuedPayloads = queued.flatMap((query) => query.values?.filter(
    (value): value is string => typeof value === 'string' && value.includes('"actorContext"'),
  ) ?? [])
  assert.equal(queuedPayloads.length, 2)
  for (const encoded of queuedPayloads) {
    const continued = JSON.parse(encoded) as RunExecuteJobPayload
    assert.equal(continued.actorContext.actionContext?.effectiveUserId, ids.human)
    assert.deepEqual(
      continued.actorContext.actionContext?.uoaIdentity,
      peerPayload.actorContext.actionContext.uoaIdentity,
    )
  }

  const firstRunId = createdRunIds[0]
  if (!firstRunId) throw new Error('continuation run was not created')
  assert.equal((JSON.parse(queuedPayloads[0] ?? '') as RunExecuteJobPayload).runId, firstRunId)

  let checkpointWhere: unknown
  const checkpoint = await loadRunCheckpointForRun({
    runBasisScope: { findMany: async () => [] },
    runCheckpoint: {
      findFirst: async ({ where }: { where: unknown }) => {
        checkpointWhere = where
        return {
          consumedByRunId: firstRunId,
          createdAt: new Date('2026-09-09T00:00:00.000Z'),
          generation: 1,
          id: 'checkpoint-1',
          note: 'Verified working notes.',
          reason: 'token_limit',
          runId: ids.run,
          sources: [{ title: 'Source', url: 'https://example.test/source' }],
        }
      },
      // The writing run consumed no checkpoint of its own.
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    runCheckpointDisclosureSource: {
      findMany: async () => [{ sourceAuthorUserId: ids.human, sourceChannelId: ids.channel }],
    },
    // Nor did it call a local program.
    toolCall: { findMany: async () => [] },
  } as never, {
    agentId: ids.agent,
    principalUserId: null,
    // An auto-continuation is unattended: it resumes only what was claimed for it.
    resumer: null,
    rootMessageId: resolveReplyRootMessageId(
      { id: ids.trigger, rootMessageId: null },
      null,
      creates[0]?.replyPlacement as 'channel',
    ) ?? null,
    runId: firstRunId,
    threadId: ids.thread,
  })
  assert.deepEqual(checkpoint?.sources, [{ title: 'Source', url: 'https://example.test/source' }])
  assert.deepEqual(checkpoint?.disclosureSources, [
    { sourceAuthorUserId: ids.human, sourceChannelId: ids.channel },
  ])
  assert.deepEqual(checkpointWhere, {
    consumedByRunId: firstRunId, reason: { not: 'crash' }, threadId: ids.thread,
  })
})

// A stopped run's continuation, `attempt` tries in, and a transaction whose
// thread slot is taken or free and whose checkpoint is resumed or not.
const CHECKPOINT_ID = '00000000-0000-4000-8000-0000000000c1'
const continuationOf = (attempt: number): RunAutoContinuationJobPayload => ({
  attempt,
  checkpointId: CHECKPOINT_ID,
  source: {
    actorContext: {
      actionContext: { requestId: 'continuation-test' },
      actor: { actorId: '00000000-0000-4000-8000-0000000000a1', actorType: 'agent' },
      tenant: { organizationId: '00000000-0000-4000-8000-0000000000a5' },
    },
    agentId: '00000000-0000-4000-8000-0000000000a1',
    messageId: '00000000-0000-4000-8000-0000000000a2',
    runId: '00000000-0000-4000-8000-0000000000a4',
    taskId: '00000000-0000-4000-8000-0000000000a7',
    threadId: '00000000-0000-4000-8000-0000000000a6',
  } as unknown as RunExecuteJobPayload,
  stoppedRun: {
    agentId: '00000000-0000-4000-8000-0000000000a1',
    channelId: '00000000-0000-4000-8000-0000000000a3',
    id: '00000000-0000-4000-8000-0000000000a4',
    organizationId: '00000000-0000-4000-8000-0000000000a5',
    principalUserId: null,
    replyPlacement: 'channel',
    threadId: '00000000-0000-4000-8000-0000000000a6',
  },
})

const slotWith = (input: { busy: boolean; consumedByRunId: string | null }) => {
  const statements: Array<{ values?: unknown[] }> = []
  const created: unknown[] = []
  const tx = {
    $executeRaw: async (sql: { values?: unknown[] }) => {
      statements.push(sql)
      return 1
    },
    run: {
      create: async ({ data }: { data: unknown }) => {
        created.push(data)
        return { id: '00000000-0000-4000-8000-0000000000b1' }
      },
      findFirst: async () => (input.busy ? { id: '00000000-0000-4000-8000-0000000000b2' } : null),
    },
    runCheckpoint: {
      findUnique: async () => ({ consumedByRunId: input.consumedByRunId }),
      updateMany: async () => ({ count: 1 }),
    },
    task: { create: async () => ({ id: '00000000-0000-4000-8000-0000000000b4' }) },
    taskEvent: { create: async () => ({}) },
  }
  const waits = () => statements.filter((sql) => sql.values?.[0] === RUN_AUTO_CONTINUATION_TOPIC)
  return { created, prisma: { $transaction: async <T>(work: (inner: typeof tx) => Promise<T>) => work(tx) }, waits }
}

// The run holding the slot resumes no checkpoint it was not handed, so a
// continuation that left the work to it used to leave it to nobody.
test('a continuation that finds its thread busy waits for it', async () => {
  const slot = slotWith({ busy: true, consumedByRunId: null })
  assert.equal(await startAutoContinuation(slot.prisma as never, continuationOf(1)), null)
  assert.deepEqual(slot.created, [])

  const [wait] = slot.waits()
  assert.ok(wait, 'it queues itself again')
  const [, encoded, , delayMs, key] = wait.values ?? []
  assert.equal((JSON.parse(encoded as string) as RunAutoContinuationJobPayload).attempt, 2)
  assert.equal(delayMs, 15_000)
  assert.equal(key, `run:continue:wait:${CHECKPOINT_ID}:2`)
})

test('a continuation stops once its checkpoint is resumed, and after its last wait', async () => {
  const resumed = slotWith({ busy: false, consumedByRunId: '00000000-0000-4000-8000-0000000000b3' })
  assert.equal(await startAutoContinuation(resumed.prisma as never, continuationOf(3)), null)
  assert.deepEqual(resumed.created, [])
  assert.deepEqual(resumed.waits(), [])

  const exhausted = slotWith({ busy: true, consumedByRunId: null })
  assert.equal(await startAutoContinuation(exhausted.prisma as never, continuationOf(12)), null)
  assert.deepEqual(exhausted.waits(), [], 'the checkpoint stays for a Continue press or reply')
})

test('a waiting continuation starts once its thread is free', async () => {
  const slot = slotWith({ busy: false, consumedByRunId: null })
  assert.equal(
    await startAutoContinuation(slot.prisma as never, continuationOf(4)),
    '00000000-0000-4000-8000-0000000000b1',
  )
  assert.equal(slot.created.length, 1)
  assert.deepEqual(slot.waits(), [])
})
