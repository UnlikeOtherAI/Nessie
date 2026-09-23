import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import type { DeepWaterBriefRun } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { wakeDeepWaterAgent } from '../../src/control/deepwater-wake.js'
import { researchId, seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The per-thread claim a DeepWater wake takes (Water plan amendments N4,
 * amendments-fable F7.2): a wake an idle agent starts at once is its run's
 * trigger, so a replay finds it and is a duplicate on the direct path as on
 * the drained one; and a Personal Assistant's wake is keyed to the person it
 * speaks for, so it waits behind that person's run in the room and never
 * behind someone else's.
 */

const withFixture = (name: string, body: (fixture: WatchFixture) => Promise<void>): void => {
  runDatabaseTest(name, async (t) => {
    const probe = new PrismaClient()
    await assertGlobalQueuesQuiet(probe)
    await probe.$disconnect()
    const fixture = await seedWatchFixture()
    t.after(() => fixture.cleanup())
    await body(fixture)
  })
}

const attachedAgentBrief = async (fixture: WatchFixture): Promise<DeepWaterBriefRun> => {
  const run = await fixture.insert('agent')
  await fixture.attach(run.id, {
    id: researchId(), status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'agent', errorCode: null, retryable: false },
  })
  return fixture.read(run.id)
}

const jobOf = async (fixture: WatchFixture, key: string) => {
  const [job] = await fixture.prisma.$queryRawUnsafe<Array<{ payload: RunExecuteJobPayload }>>(
    'SELECT payload FROM queue_jobs WHERE idempotency_key = $1',
    key,
  )
  return job?.payload
}

withFixture('a wake an idle agent starts at once is its run\'s trigger, so a replay is a duplicate', async (fixture) => {
  const { prisma, ids } = fixture
  const brief = await attachedAgentBrief(fixture)
  const turnId = brief.scopeState?.turn?.id ?? ''
  const wake = () => prisma.$transaction((tx) =>
    wakeDeepWaterAgent(tx, brief, { agentId: ids.agent, kind: 'turn', turnId, content: 'The planner answered.' }))

  const first = await wake()
  assert.equal(first.kind, 'claimed')
  const kickoffId = first.kind === 'claimed' ? first.kickoffId : ''
  const started = await prisma.run.findMany({ where: { agentId: ids.agent, triggerMessageId: kickoffId } })
  assert.equal(started.length, 1, 'the direct path records the kickoff as the run\'s trigger')
  assert.equal(started[0]?.principalUserId, null)

  // The same wake again — a replayed job, or the watch and a retry racing —
  // finds the run it started, even after that run finished.
  assert.equal((await wake()).kind, 'duplicate')
  await prisma.run.update({ where: { id: started[0]?.id ?? '' }, data: { status: 'completed' } })
  assert.equal((await wake()).kind, 'duplicate')
  assert.equal(await prisma.run.count({ where: { agentId: ids.agent, triggerMessageId: kickoffId } }), 1)
  assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId: ids.thread } }), 0)
  assert.equal(await prisma.message.count({ where: { id: kickoffId } }), 1)
})

withFixture('a Personal Assistant\'s wake waits behind its own person\'s run, never another person\'s', async (fixture) => {
  const { prisma, ids } = fixture
  const assistant = await prisma.agent.create({
    data: {
      name: 'Personal Assistant',
      organizationId: ids.organization,
      projectId: ids.project,
      teamId: ids.team,
      role: 'assistant',
      agentKind: 'personal_assistant',
      systemManaged: true,
      surfacePolicy: 'dm_only',
      delegationMode: 'act_as_requesting_user',
    },
  })
  const colleague = await prisma.user.create({
    data: { displayName: 'Colleague', email: `dw-pa-${randomUUID()}@example.test` },
  })
  // Runs, pending rows and the kickoffs go with the organisation; the colleague by id.
  const cleanupColleague = () => prisma.user.deleteMany({ where: { id: colleague.id } })
  try {
    // The assistant is busy in this room for the colleague.
    await prisma.run.create({
      data: { agentId: assistant.id, principalUserId: colleague.id, threadId: ids.thread, status: 'running' },
    })
    const brief = await attachedAgentBrief(fixture)
    // The brief the assistant opened for the requester, in their presence here.
    const asAssistant: DeepWaterBriefRun = { ...brief, originAgentId: assistant.id, principalUserId: ids.requester }
    const wake = (turnId: string) => prisma.$transaction((tx) =>
      wakeDeepWaterAgent(tx, asAssistant, { agentId: assistant.id, kind: 'turn', turnId, content: 'Answered.' }))

    const first = await wake(randomUUID())
    assert.equal(first.kind, 'claimed', 'the colleague\'s run is another person\'s slot')
    const firstRun = await prisma.run.findFirstOrThrow({
      where: { agentId: assistant.id, triggerMessageId: first.kind === 'claimed' ? first.kickoffId : '' },
    })
    assert.equal(firstRun.principalUserId, ids.requester)
    assert.equal((await jobOf(fixture, `run:${firstRun.id}`))?.principalUserId, ids.requester)

    const second = await wake(randomUUID())
    assert.equal(second.kind, 'pended', 'it waits behind the requester\'s own run')
    const [pending] = await prisma.runThreadPendingMessage.findMany({ where: { agentId: assistant.id } })
    assert.equal(pending?.principalUserId, ids.requester)

    await prisma.run.update({ where: { id: firstRun.id }, data: { status: 'completed' } })
    const drained = await drainPendingThreadMessages(prisma, {
      agentId: assistant.id,
      principalUserId: ids.requester,
      threadId: ids.thread,
    })
    assert.ok(drained)
    const next = await prisma.run.findUniqueOrThrow({ where: { id: drained } })
    assert.equal(next.triggerMessageId, second.kind === 'pended' ? second.kickoffId : null)
    assert.equal(next.principalUserId, ids.requester)
    const payload = await jobOf(fixture, `run:batch:${next.id}`)
    assert.equal(payload?.actorContext.actionContext.purpose, 'deep_water.delivery')
    assert.equal(payload?.actorContext.actionContext.effectiveUserId, ids.requester)
  } finally {
    await prisma.run.deleteMany({ where: { agentId: assistant.id } })
    await cleanupColleague()
  }
})
