import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseTeamId,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { claimThreadRunOrPend, drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { wakeDeepWaterAgent } from '../../src/control/deepwater-wake.js'
import { researchId, seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * A DeepWater wake is one run per wake (Water plan amendments N4): when the
 * agent is busy, each wake waits in the per-thread queue and drains alone,
 * never folded into someone else's message or another wake, so every woken run
 * carries its own requester's identity. A replayed wake is a duplicate.
 */

runDatabaseTest('wakes that wait behind a busy agent each drain alone, in arrival order', async (t) => {
  const probe = new PrismaClient()
  await assertGlobalQueuesQuiet(probe)
  await probe.$disconnect()
  const fixture: WatchFixture = await seedWatchFixture()
  t.after(() => fixture.cleanup())
  const { prisma, ids } = fixture

  const busy = await prisma.run.create({ data: { agentId: ids.agent, threadId: ids.thread, status: 'running' } })
  const brief = async () => {
    const run = await fixture.insert('agent')
    await fixture.attach(run.id, {
      id: researchId(), status: 'drafting', errorCode: null, title: null, brief: null,
      turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'agent', errorCode: null, retryable: false },
    })
    return fixture.read(run.id)
  }
  const wake = (run: Awaited<ReturnType<typeof brief>>, turnId: string) => prisma.$transaction((tx) =>
    wakeDeepWaterAgent(tx, run, { agentId: ids.agent, kind: 'turn', turnId, content: 'The planner answered.' }))

  const briefA = await brief()
  const turnA = briefA.scopeState?.turn?.id ?? ''
  const wakeA = await wake(briefA, turnA)
  assert.equal(wakeA.kind, 'pended')
  await sleep(5)

  const colleague = await prisma.user.create({ data: { displayName: 'Colleague', email: `dw-${randomUUID()}@example.test` } })
  t.after(() => prisma.user.deleteMany({ where: { id: colleague.id } }).then(() => undefined))
  const message = await prisma.message.create({
    data: { threadId: ids.thread, role: 'user', content: 'Any news?', userId: colleague.id },
  })
  const chatActor: AuthorizedActionContext = {
    actor: { actorType: 'user', actorId: colleague.id, roles: ['member'] },
    tenant: { organizationId: parseOrganizationId(ids.organization), teamId: parseTeamId(ids.team) },
    actionContext: { requestId: randomUUID() },
  }
  assert.equal(await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
    agentId: ids.agent,
    threadId: ids.thread,
    pending: { actorContext: chatActor, channelId: ids.channel, interactive: true, messageId: message.id },
  })), 'pended')
  await sleep(5)

  const briefB = await brief()
  const wakeB = await wake(briefB, briefB.scopeState?.turn?.id ?? '')
  assert.equal(wakeB.kind, 'pended')
  assert.equal((await wake(briefA, turnA)).kind, 'duplicate', 'a replayed wake is recognised')

  const drained: Array<{ trigger: string | null; purpose: string | undefined }> = []
  let active = busy.id
  for (let index = 0; index < 3; index += 1) {
    await prisma.run.update({ where: { id: active }, data: { status: 'completed' } })
    const next = await drainPendingThreadMessages(prisma, { agentId: ids.agent, threadId: ids.thread })
    assert.ok(next, `drain ${index + 1} starts a run`)
    const run = await prisma.run.findUniqueOrThrow({ where: { id: next } })
    const [job] = await prisma.$queryRawUnsafe<Array<{ payload: RunExecuteJobPayload }>>(
      `SELECT payload FROM queue_jobs WHERE idempotency_key = $1`,
      `run:batch:${run.id}`,
    )
    drained.push({ trigger: run.triggerMessageId, purpose: job?.payload.actorContext.actionContext.purpose })
    active = run.id
  }
  await prisma.run.update({ where: { id: active }, data: { status: 'completed' } })

  assert.deepEqual(drained, [
    { trigger: wakeA.kind === 'pended' ? wakeA.kickoffId : null, purpose: 'deep_water.delivery' },
    { trigger: message.id, purpose: undefined },
    { trigger: wakeB.kind === 'pended' ? wakeB.kickoffId : null, purpose: 'deep_water.delivery' },
  ])
  assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId: ids.thread } }), 0)
})
