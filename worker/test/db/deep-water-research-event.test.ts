import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { toDeepWaterBriefView } from '@nessie/runtime'
import {
  DeepWaterDeliveryMessageMetadataSchema,
  DeepWaterNoticeMessageMetadataSchema,
  DeepWaterResearchEventJobPayloadSchema,
  type DeepWaterResearchEventJobPayload,
} from '@nessie/schemas'

import { handleDeepWaterResearchEvent } from '../../src/control/deepwater-research-event.js'
import { deepWaterWakeKickoffId } from '../../src/control/deepwater-wake.js'
import { launchedBrief, researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * DeepWater's research events, handled (Water plan amendments-streaming S2).
 * Progress is stored and announced, and does nothing else — no Ledger read,
 * wake, message, alert or push. A settled turn or an outcome makes the
 * watch's own read, so the agent that wrote a turn is woken once, a person's
 * reply stops "replying", and a finished research is delivered once with its
 * alert — however often DeepWater sends the event.
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

type EventInput = {
  type: DeepWaterResearchEventJobPayload['event']['type']
  status: DeepWaterResearchEventJobPayload['event']['research']['status']
  progress?: DeepWaterResearchEventJobPayload['event']['progress']
  turn?: DeepWaterResearchEventJobPayload['event']['turn']
  reportKind?: 'full' | 'summary' | null
  eventId?: string
}

/** A verified event as the receiver queues it, shaped like DeepWater's published examples. */
const eventFor = (fixture: WatchFixture, runId: string, rs: string, input: EventInput): DeepWaterResearchEventJobPayload =>
  DeepWaterResearchEventJobPayloadSchema.parse({
    organizationId: fixture.ids.organization,
    runId,
    event: {
      ver: 'deepwater.research-event.v1',
      event_id: input.eventId ?? `evt_${randomUUID().replaceAll('-', '')}`,
      type: input.type,
      sent_at: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      research: {
        ledger_research_id: rs,
        status: input.status,
        title: null,
        report_kind: input.reportKind ?? null,
        public_url: null,
        error_code: null,
      },
      progress: input.progress ?? null,
      turn: input.turn ?? null,
      nessie: {
        organization_id: fixture.ids.organization,
        team_id: fixture.ids.team,
        user_id: fixture.ids.requester,
        run_id: runId,
        agent_id: null,
        tool_call_id: null,
        thread_id: fixture.ids.thread,
      },
    },
  })

const handle = (fixture: WatchFixture, payload: DeepWaterResearchEventJobPayload) =>
  handleDeepWaterResearchEvent(fixture.deps, payload)

const launchedResearch = async (fixture: WatchFixture, origin: 'person' | 'agent') => {
  const run = await fixture.insert(origin)
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: launchedBrief(),
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: origin, errorCode: null, retryable: false },
  })
  return { run: await fixture.read(run.id), rs }
}

const gathering = (at: string, percent: number | null = 40) => ({
  phase: 'gathering' as const,
  note: 'Finding and reading sources',
  percent,
  sources_found: 23,
  at,
})

const threadMessages = (fixture: WatchFixture) =>
  fixture.prisma.message.count({ where: { threadId: { in: [fixture.ids.thread, fixture.ids.assistantThread] } } })

const organisationJobs = (fixture: WatchFixture, topic: string) => fixture.prisma.$queryRawUnsafe<unknown[]>(
  `SELECT id FROM queue_jobs WHERE topic = $1 AND (payload->>'organizationId' = $2 OR payload->>'threadId' = ANY($3))`,
  topic,
  fixture.ids.organization,
  [fixture.ids.thread, fixture.ids.assistantThread],
)

withFixture('progress is stored and announced, and does nothing else', async (fixture) => {
  const { run, rs } = await launchedResearch(fixture, 'person')
  const messagesBefore = await threadMessages(fixture)
  fixture.realtime.published.length = 0

  await handle(fixture, eventFor(fixture, run.id, rs, {
    type: 'research.progress', status: 'running', progress: gathering('2026-09-23T10:15:00.000Z'),
  }))
  const stored = await fixture.read(run.id)
  assert.deepEqual(stored.scopeState?.progress, {
    phase: 'gathering', note: 'Finding and reading sources', percent: 40, sourcesFound: 23, at: '2026-09-23T10:15:00.000Z',
  })
  assert.ok(stored.lastEventAt)
  const announced = fixture.realtime.published
  assert.ok(announced.length > 0, 'the run is announced')
  assert.ok(announced.every((event) => event.event === 'integration.run.updated'), 'and nothing else is')
  assert.ok(announced.some((event) => event.scopes.some((scope) => scope.kind === 'user' && scope.userId === fixture.ids.requester)))
  assert.ok(announced.every((event) => JSON.stringify(event.data) === JSON.stringify({ productSlug: 'deep-water', runId: run.id })))

  // No Ledger read, no message, no alert, no push, no wake — whatever the progress says.
  assert.deepEqual(fixture.ledger.calls, [])
  assert.equal(await threadMessages(fixture), messagesBefore)
  assert.equal(await fixture.prisma.userAlert.count({ where: { userId: fixture.ids.requester } }), 0)
  assert.deepEqual(await organisationJobs(fixture, 'push.dispatch'), [])
  assert.deepEqual(await organisationJobs(fixture, 'run.execute'), [])

  // An older snapshot arriving late changes nothing and announces nothing.
  fixture.realtime.published.length = 0
  await handle(fixture, eventFor(fixture, run.id, rs, {
    type: 'research.progress', status: 'running', progress: { ...gathering('2026-09-23T10:14:00.000Z', 10), phase: 'scoping' },
  }))
  assert.deepEqual((await fixture.read(run.id)).scopeState?.progress?.at, '2026-09-23T10:15:00.000Z')
  assert.deepEqual(fixture.realtime.published, [])

  // The view streams it: a running research shows where it stands.
  const view = toDeepWaterBriefView(await fixture.read(run.id), {
    viewer: { userId: fixture.ids.requester, canChangeTeam: false },
    reportSpaceId: null,
    now: new Date(),
    planner: { displayName: 'DeepWater', iconUrl: null },
  })
  assert.equal(view.status, 'running')
  assert.equal(view.progress?.phase, 'gathering')
  assert.equal(view.progress?.sourcesFound, 23)
})

withFixture('a settled turn wakes the agent that wrote it, once, however often the event comes', async (fixture) => {
  const run = await fixture.insert('agent')
  const rs = researchId()
  const turnId = randomUUID()
  await fixture.attach(run.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: turnId, seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_scope_get', (args) => wireScope({
    id: rs,
    turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'agent' },
    revision: 1,
    withTranscript: args.include_transcript === true,
  }))
  const settled = eventFor(fixture, run.id, rs, {
    type: 'research.scope.turn_settled', status: 'drafting', turn: { turn_id: turnId, status: 'complete', revision: 1 },
  })
  await handle(fixture, settled)
  // DeepWater's start-up sweep sends it again.
  await handle(fixture, settled)

  const reads = fixture.ledger.calls.filter((call) => call.toolName === 'research_scope_get')
  assert.ok(reads.length >= 2, 'each event is a read through Ledger')
  assert.ok(reads.every((call) => call.toolCallId.startsWith(`watch:${run.id}:`)), 'the watch\'s own read')
  assert.equal(new Set(reads.map((call) => call.toolCallId.split(':')[2])).size >= 2, true, 'each on a claim of its own')
  const woken = await fixture.read(run.id)
  assert.equal(woken.agentWakeCount, 1)
  assert.equal(woken.lastHandledTurnSeq, 1)
  assert.ok(woken.lastEventAt)
  const kickoffs = await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread, role: 'system' } })
  assert.equal(kickoffs.length, 1)
  assert.equal(kickoffs[0]?.id, deepWaterWakeKickoffId(run.id, 'turn', turnId))
  assert.equal(DeepWaterDeliveryMessageMetadataSchema.parse(kickoffs[0]?.metadata).deepWaterDelivery.kind, 'turn')
})

withFixture('a person\'s reply stops "replying" the moment its turn event lands, and wakes nobody', async (fixture) => {
  const run = await fixture.insert('person')
  const rs = researchId()
  const turnId = randomUUID()
  await fixture.attach(run.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: turnId, seq: 1, status: 'pending', authorKind: 'person', errorCode: null, retryable: false },
  })
  const viewOf = async () => toDeepWaterBriefView(await fixture.read(run.id), {
    viewer: { userId: fixture.ids.requester, canChangeTeam: false },
    reportSpaceId: null,
    now: new Date(),
    planner: { displayName: 'DeepWater', iconUrl: null },
  })
  assert.equal((await viewOf()).plannerTurn.status, 'replying')
  fixture.ledger.answer('research_scope_get', (args) => wireScope({
    id: rs,
    turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'person' },
    revision: 1,
    withTranscript: args.include_transcript === true,
  }))
  await handle(fixture, eventFor(fixture, run.id, rs, {
    type: 'research.scope.turn_settled', status: 'drafting', turn: { turn_id: turnId, status: 'complete', revision: 1 },
  }))
  const view = await viewOf()
  assert.equal(view.plannerTurn.status, 'idle')
  assert.equal(view.revision, 1)
  assert.equal(await fixture.prisma.message.count({ where: { threadId: fixture.ids.thread, role: 'system' } }), 0)
  assert.ok(fixture.realtime.published.some((event) => event.event === 'integration.run.updated'))
})

withFixture('a finished research is delivered once, with its reply, mention and push, when its event lands', async (fixture) => {
  const { run, rs } = await launchedResearch(fixture, 'person')
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', {
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
  })
  const completed = eventFor(fixture, run.id, rs, { type: 'research.completed', status: 'complete', reportKind: 'full' })
  await handle(fixture, completed)
  await handle(fixture, completed)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.ok(delivered.deliveredAt)
  assert.equal(fixture.ledger.calls.filter((call) => call.toolName === 'research_report').length, 1)
  const replies = (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread } }))
    .filter((message) => DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata).success)
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.id, delivered.resultMessageId)
  const alerts = await fixture.prisma.userAlert.findMany({ where: { messageId: replies[0]?.id } })
  assert.deepEqual(alerts.map((alert) => alert.eventKey), [`deep-water-result:${run.id}`])
  const pushes = await fixture.prisma.queueJob.count({ where: { idempotencyKey: `push:${replies[0]?.id}` } })
  assert.equal(pushes, 1)
  // Progress stops meaning anything once the research is done.
  await handle(fixture, eventFor(fixture, run.id, rs, {
    type: 'research.progress', status: 'running', progress: gathering(new Date().toISOString()),
  }))
  assert.equal((await fixture.read(run.id)).scopeState?.progress ?? null, null)
})

withFixture('an agent\'s finished research wakes the agent, and a blocked run is left to its requester', async (fixture) => {
  const { run, rs } = await launchedResearch(fixture, 'agent')
  fixture.ledger.answer('research_status', { id: rs, status: 'failed', title: 'Heat pumps', error_code: 'quality_gate_failed' })
  await handle(fixture, eventFor(fixture, run.id, rs, { type: 'research.failed', status: 'failed' }))
  const failed = await fixture.read(run.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.wakeMessageId, deepWaterWakeKickoffId(run.id, 'failed', null))

  const blocked = await launchedResearch(fixture, 'person')
  await fixture.prisma.productIntegrationRun.update({
    where: { id: blocked.run.id },
    data: { deliveryBlockedReason: 'requester_identity_changed' },
  })
  const callsBefore = fixture.ledger.calls.length
  await handle(fixture, eventFor(fixture, blocked.run.id, blocked.rs, { type: 'research.completed', status: 'complete', reportKind: 'full' }))
  assert.equal(fixture.ledger.calls.length, callsBefore, 'the watch does not read a blocked run, so neither does its event')
  const after = await fixture.read(blocked.run.id)
  assert.equal(after.status, 'running')
  assert.ok(after.lastEventAt, 'the event is still recorded')
})

withFixture('while events arrive the watch reads a running research every 60 s, not every 30', async (fixture) => {
  const { run, rs } = await launchedResearch(fixture, 'person')
  fixture.ledger.answer('research_status', { id: rs, status: 'running', title: 'Heat pumps', error_code: null })
  await handle(fixture, eventFor(fixture, run.id, rs, {
    type: 'research.scope.turn_settled', status: 'running', turn: { turn_id: randomUUID(), status: 'complete', revision: 2 },
  }))
  const next = (await fixture.read(run.id)).reconcileAfter.getTime() - Date.now()
  assert.ok(next > 50_000 && next <= 61_000, `next read in ${next} ms`)
})
