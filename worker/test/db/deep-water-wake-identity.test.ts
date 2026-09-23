import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { DeepWaterNoticeMessageMetadataSchema, RunExecuteJobPayloadSchema } from '@nessie/schemas'

import { tellRequesterDeepWaterWakeFailed } from '../../src/control/deepwater-wake-failure.js'
import { deepWaterWakeKickoffId } from '../../src/control/deepwater-wake.js'
import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { handleRunExecutionFailure } from '../../src/run/execute/failure.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import { launchedBrief, researchId, seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * A woken agent that cannot act for the person who asked, because their
 * sign-in changed after the research was delivered to it (Water plan
 * amendments-fable F4, amendments N4). Delivery counted the wake when it was
 * claimed, so the run's own failure is where the person must be told: DeepWater's
 * notice with the report's link, never only the agent's generic apology.
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

const watch = async (fixture: WatchFixture, runId: string) => watchDeepWaterRun(fixture.deps, await fixture.read(runId))

const report = {
  report_markdown: '# Heat pumps\n\nThey work.',
  references: [],
  depth: 'light',
  started_at: '2026-09-23T09:00:00.000Z',
  completed_at: '2026-09-23T09:30:00.000Z',
  truncated: false,
  title: 'Heat pumps',
  report_kind: 'full',
  full_report_error_code: null,
  public_url: null,
}

/** An agent's research Ledger finished (or failed), delivered by one watch read: the agent is woken. */
const deliveredToAgent = async (fixture: WatchFixture, outcome: 'complete' | 'failed') => {
  const run = await fixture.insert('agent')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: launchedBrief(),
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'agent', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_status', {
    id: rs, status: outcome, title: 'Heat pumps', error_code: outcome === 'failed' ? 'upstream_failed' : null,
  })
  fixture.ledger.answer('research_report', report)
  await watch(fixture, run.id)
  const delivered = await fixture.read(run.id)
  const kind = outcome === 'complete' ? 'completed' : 'failed'
  assert.equal(delivered.wakeMessageId, deepWaterWakeKickoffId(run.id, kind, null), 'the agent was woken')
  return delivered
}

/** Fail the woken agent's run as its model call would when it cannot sign as the requester. */
const failWokenRun = async (fixture: WatchFixture, kickoffId: string, cardId: string | null) => {
  const woken = await fixture.prisma.run.findFirstOrThrow({ where: { triggerMessageId: kickoffId } })
  const task = await fixture.prisma.task.findFirstOrThrow({ where: { runId: woken.id } })
  const [job] = await fixture.prisma.$queryRawUnsafe<Array<{ payload: unknown }>>(
    `SELECT payload FROM queue_jobs WHERE topic = 'run.execute' AND payload->>'runId' = $1`,
    woken.id,
  )
  const payload = RunExecuteJobPayloadSchema.parse(job?.payload)
  const deps = {
    prisma: fixture.prisma,
    realtimeTransport: { publishSse: async () => undefined, publishWs: fixture.deps.realtime.publishWs },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: fixture.ids.agent,
      name: 'Analyst',
      parentAgentId: null,
      model: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [fixture.ids.agent],
    channel: {
      id: fixture.ids.channel,
      organizationId: fixture.ids.organization,
      projectId: fixture.ids.project,
      systemChannelType: null,
      visibility: 'public',
      teamId: fixture.ids.team,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: woken.createdAt, id: woken.id, replyPlacement: 'channel', threadId: fixture.ids.thread },
    replyRootMessageId: cardId,
    task: { id: task.id },
  } satisfies RunContext
  // An inference stage keeps only the message of what it caught, and marks the refusal.
  const error = Object.assign(new Error('UOA delegation exchange failed'), { requesterIdentityRefused: true as const })
  await handleRunExecutionFailure(deps, payload, context, { error, planContext: null, streamStarted: false })
  return woken
}

/** What the agent said in the room, apart from its research card. */
const agentReplies = (fixture: WatchFixture, cardId: string | null) =>
  fixture.prisma.message.findMany({
    where: { threadId: fixture.ids.thread, agentId: fixture.ids.agent, role: 'assistant', id: { not: cardId ?? undefined } },
  })

const noticesOf = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread }, orderBy: { createdAt: 'asc' } }))
    .flatMap((message) => {
      const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
      return notice.success && notice.data.deepWaterNotice.runId === runId
        ? [{ ...message, kind: notice.data.deepWaterNotice.kind }]
        : []
    })

withFixture('a woken agent that cannot act for a changed sign-in leaves its requester the report, once', async (fixture) => {
  const delivered = await deliveredToAgent(fixture, 'complete')
  const kickoffId = delivered.wakeMessageId ?? ''
  const woken = await failWokenRun(fixture, kickoffId, delivered.cardMessageId)

  assert.equal((await fixture.prisma.run.findUniqueOrThrow({ where: { id: woken.id } })).status, 'failed')
  assert.deepEqual(await agentReplies(fixture, delivered.cardMessageId), [], 'no generic apology from the agent')
  const [notice, ...more] = await noticesOf(fixture, delivered.id)
  assert.equal(more.length, 0)
  assert.equal(notice?.kind, 'wake_unreachable')
  assert.equal(notice?.rootMessageId, delivered.cardMessageId, 'under the research card')
  assert.match(notice?.content ?? '', /sign-in has changed/)
  const page = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: delivered.knowledgePageId ?? '' } })
  assert.match(notice?.content ?? '', new RegExp(`/knowledge-base\\?spaceId=${page.spaceId}&pageId=${page.id}`))
  assert.equal((await fixture.read(delivered.id)).resultMessageId, notice?.id)
  const alerts = await fixture.prisma.userAlert.findMany({ where: { messageId: notice?.id ?? '' } })
  assert.deepEqual(
    alerts.map((alert) => [alert.userId, alert.eventKey]),
    [[fixture.ids.requester, `deep-water-wake-identity:${delivered.id}`]],
  )

  // A replayed failure tells nobody twice.
  const again = await tellRequesterDeepWaterWakeFailed(fixture.deps, {
    organizationId: fixture.ids.organization,
    kickoffMessageId: kickoffId,
  })
  assert.equal(again, 'told')
  assert.equal((await noticesOf(fixture, delivered.id)).length, 1)
})

withFixture('a failed research whose agent cannot act for its requester is told to them as failed', async (fixture) => {
  const delivered = await deliveredToAgent(fixture, 'failed')
  await failWokenRun(fixture, delivered.wakeMessageId ?? '', delivered.cardMessageId)

  assert.deepEqual(await agentReplies(fixture, delivered.cardMessageId), [])
  const [notice] = await noticesOf(fixture, delivered.id)
  assert.equal(notice?.kind, 'failed')
  assert.match(notice?.content ?? '', /didn't finish/)
  assert.match(notice?.content ?? '', /Sign in again/)
})

withFixture('only a terminal wake of a delivered research is DeepWater\'s to tell', async (fixture) => {
  const tell = (kickoffMessageId: string) => tellRequesterDeepWaterWakeFailed(fixture.deps, {
    organizationId: fixture.ids.organization,
    kickoffMessageId,
  })
  // A trigger that is no DeepWater kickoff at all.
  const ordinary = await fixture.prisma.message.create({
    data: { threadId: fixture.ids.thread, role: 'user', content: 'Hello', userId: fixture.ids.requester },
  })
  assert.equal(await tell(ordinary.id), 'not_owed')
  assert.equal(await tell(randomUUID()), 'not_owed')

  // A planner-turn wake: the brief's own watch read blocks and tells them.
  const brief = await fixture.insert('agent')
  const turnKickoff = await fixture.prisma.message.create({
    data: {
      id: deepWaterWakeKickoffId(brief.id, 'turn', randomUUID()),
      threadId: fixture.ids.thread,
      role: 'system',
      content: 'turn',
      agentId: fixture.ids.agent,
      metadata: { deepWaterDelivery: { schemaVersion: 1, runId: brief.id, kind: 'turn', turnId: randomUUID() } },
    },
  })
  assert.equal(await tell(turnKickoff.id), 'not_owed')
  assert.deepEqual(await noticesOf(fixture, brief.id), [])
})
