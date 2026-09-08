import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'
import { loadRunCheckpointForRun } from './checkpoint.js'
import { enqueueAutoContinuation, isInteractiveRun, shouldAutoContinue } from './continuation.js'
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
    runCheckpoint: { updateMany: async () => ({ count: 1 }) },
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
      updateMany: async () => ({ count: 0 }),
    },
    runCheckpointDisclosureSource: {
      findMany: async () => [{ sourceAuthorUserId: ids.human, sourceChannelId: ids.channel }],
    },
  } as never, {
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
    OR: [{ consumedByRunId: firstRunId }, { consumedByRunId: null, rootMessageId: null }],
    reason: { not: 'crash' }, threadId: ids.thread,
  })
})
