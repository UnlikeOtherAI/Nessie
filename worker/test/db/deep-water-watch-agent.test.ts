import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { DeepWaterDeliveryMessageMetadataSchema, type RunExecuteJobPayload } from '@nessie/schemas'

import { reapUnconfirmedDeepWaterBriefs } from '../../src/control/deepwater-worker.js'
import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { deepWaterWakeKickoffId } from '../../src/control/deepwater-wake.js'
import { researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The watch for a brief an agent opened (Water plan amendments-fable F1,
 * amendments N1, N3, N4, N5): a lost scope start is found by replaying the
 * agent's own call and gets the agent's card; a settled planner turn wakes the
 * agent once, under the card, as the person it asked for; a finished research
 * is imported and wakes the agent to answer; and a brief never confirmed wakes
 * it once to say so.
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

const kickoffs = (fixture: WatchFixture) => fixture.prisma.message.findMany({
  where: { threadId: fixture.ids.thread, role: 'system' },
  orderBy: { createdAt: 'asc' },
})

withFixture('a lost scope start is replayed as the agent\'s own call, attached, and gets the agent\'s card', async (fixture) => {
  const run = await fixture.insert('agent', { toolCallId: 'call_scope_start_1' })
  const rs = researchId()
  const opening = { id: randomUUID(), seq: 1, status: 'pending', author_kind: 'agent' as const }
  fixture.ledger.answer('research_scope_start', wireScope({ id: rs, turn: opening }))

  await watch(fixture, run.id)
  const [call] = fixture.ledger.calls
  assert.equal(call?.toolName, 'research_scope_start')
  assert.equal(call?.toolCallId, 'call_scope_start_1', 'the replay reuses the agent\'s tool-call id')
  assert.deepEqual(call?.args, { topic: 'Heat pumps in older houses', settings: { depth: 'light' } })

  const attached = await fixture.read(run.id)
  assert.equal(attached.externalRunId, rs)
  assert.equal(attached.status, 'drafting')
  assert.ok(attached.cardMessageId)
  const card = await fixture.prisma.message.findUniqueOrThrow({ where: { id: attached.cardMessageId } })
  assert.equal(card.agentId, fixture.ids.agent)
  assert.equal(card.role, 'assistant')
  assert.deepEqual(card.metadata, { researchRunRef: { schemaVersion: 1, runId: run.id } })

  // Watching again reads the brief; it never posts a second card.
  fixture.ledger.answer('research_scope_get', wireScope({ id: rs, turn: opening }))
  await watch(fixture, run.id)
  assert.equal(await fixture.prisma.message.count({ where: { threadId: fixture.ids.thread, role: 'assistant' } }), 1)
})

withFixture('a settled planner turn wakes its agent once, under the card, as the person it asked for', async (fixture) => {
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
  await watch(fixture, run.id)
  await watch(fixture, run.id)

  const reads = fixture.ledger.calls.filter((call) => call.toolName === 'research_scope_get')
  assert.equal(reads[0]?.args.include_transcript, false, 'an open turn is read without its transcript')
  assert.equal(reads[1]?.args.include_transcript, true, 'the settled answer is followed by its transcript')

  const woken = await fixture.read(run.id)
  assert.equal(woken.agentWakeCount, 1)
  assert.equal(woken.lastHandledTurnSeq, 1)
  assert.equal(woken.scopeState?.brief?.messagesRevision, 1)
  const [kickoff] = await kickoffs(fixture)
  assert.equal(kickoff?.id, deepWaterWakeKickoffId(run.id, 'turn', turnId))
  assert.deepEqual(
    DeepWaterDeliveryMessageMetadataSchema.parse(kickoff?.metadata).deepWaterDelivery,
    { schemaVersion: 1, runId: run.id, kind: 'turn', turnId },
  )
  assert.match(kickoff?.content ?? '', /mcp_research_scope_get/)
  const wakeRun = await fixture.prisma.run.findFirstOrThrow({ where: { triggerMessageId: kickoff?.id } })
  assert.equal(wakeRun.agentId, fixture.ids.agent)
  const [job] = await fixture.prisma.$queryRawUnsafe<Array<{ payload: RunExecuteJobPayload }>>(
    `SELECT payload FROM queue_jobs WHERE idempotency_key = $1`,
    `run:${wakeRun.id}`,
  )
  assert.equal(job?.payload.actorContext.actionContext.purpose, 'deep_water.delivery')
  assert.equal(job?.payload.actorContext.actionContext.effectiveUserId, fixture.ids.requester)
  assert.deepEqual(job?.payload.actorContext.actionContext.uoaIdentity, fixture.identity)
  assert.notEqual(job?.payload.interactive, true, 'nobody is at the keyboard')

  // The brief the agent opened changed: its requester and its room hear so, with no content.
  const runEvents = fixture.realtime.published.filter((event) => event.event === 'integration.run.updated')
  assert.ok(runEvents.length > 0)
  assert.ok(runEvents.every((event) => JSON.stringify(event.data) === JSON.stringify({ productSlug: 'deep-water', runId: run.id })))
  assert.ok(runEvents.some((event) => event.scopes.some((scope) => scope.kind === 'channel')))
  assert.ok(runEvents.some((event) => event.scopes.some((scope) => scope.kind === 'user')))
})

withFixture('a finished research is imported to Documents and wakes the agent to answer, once', async (fixture) => {
  const run = await fixture.insert('agent')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'agent', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null, public_url: null })
  fixture.ledger.answer('research_report', {
    report_markdown: '# Heat pumps\n\nThey work.',
    references: [{ title: 'Study, "A"', url: 'https://example.org/a', accessed_at: '2026-09-23T09:00:00.000Z' }],
    depth: 'light',
    started_at: '2026-09-23T09:00:00.000Z',
    completed_at: '2026-09-23T09:30:00.000Z',
    truncated: false,
    title: 'Heat pumps',
    report_kind: 'full',
    full_report_error_code: null,
    public_url: null,
  })
  await watch(fixture, run.id)
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.ok(delivered.deliveredAt)
  assert.equal(delivered.sourceCount, 1)
  assert.equal(delivered.reportKind, 'full')
  assert.equal(delivered.wakeMessageId, deepWaterWakeKickoffId(run.id, 'completed', null))
  assert.ok(delivered.knowledgePageId && delivered.reportFileId && delivered.sourcesFileId)
  const page = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: delivered.knowledgePageId } })
  assert.deepEqual(page.metadata, { deepWaterReport: { runId: run.id, reportFileId: delivered.reportFileId } })
  const sources = await fixture.deps.fileService.openStream(delivered.sourcesFileId, fixture.ids.organization)
  const chunks: Buffer[] = []
  for await (const chunk of sources?.stream ?? []) chunks.push(Buffer.from(chunk as Buffer))
  assert.equal(
    Buffer.concat(chunks).toString('utf8'),
    'title,url,accessed_at\r\n"Study, ""A""",https://example.org/a,2026-09-23T09:00:00.000Z\r\n',
  )
  assert.equal(fixture.ledger.calls.filter((call) => call.toolName === 'research_report').length, 1)
  const terminal = await kickoffs(fixture)
  assert.equal(terminal.length, 1, 'one terminal wake')
  assert.ok(delivered.cardMessageId, 'the launched research got its card')
  assert.equal(terminal[0]?.rootMessageId, delivered.cardMessageId, 'the agent answers under the research card')
})

withFixture('a brief DeepWater never confirmed wakes its agent once to say so', async (fixture) => {
  const run = await fixture.insert('agent')
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
  })
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)

  const reaped = await fixture.read(run.id)
  assert.equal(reaped.status, 'failed')
  assert.equal(reaped.failureCode, 'start_unconfirmed')
  const kickoff = await kickoffs(fixture)
  assert.deepEqual(kickoff.map((message) => message.id), [deepWaterWakeKickoffId(run.id, 'start_unconfirmed', null)])
})

const finishResearch = async (fixture: WatchFixture) => {
  const run = await fixture.insert('agent')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'agent', errorCode: null, retryable: false },
  })
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
  })
  return run
}

const noticeKinds = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread }, orderBy: { createdAt: 'asc' } }))
    .flatMap((message) => {
      const notice = (message.metadata as { deepWaterNotice?: { runId: string; kind: string } } | null)?.deepWaterNotice
      return notice?.runId === runId ? [notice.kind] : []
    })

withFixture('an agent no longer bound to the room is not woken; the person is told instead', async (fixture) => {
  const run = await finishResearch(fixture)
  await fixture.prisma.agentBinding.deleteMany({ where: { agentId: fixture.ids.agent, channelId: fixture.ids.channel } })
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.equal(delivered.wakeMessageId, null, 'no kickoff for an unbound agent')
  assert.ok(delivered.resultMessageId, 'the person\'s notice is the delivery')
  assert.deepEqual(await kickoffs(fixture), [])
  assert.equal(await fixture.prisma.run.count({ where: { agentId: fixture.ids.agent, status: 'pending' } }), 0)
  assert.deepEqual(await noticeKinds(fixture, run.id), ['wake_unreachable'])
})

withFixture('a requester who left a private room is not acted for there; they are told instead', async (fixture) => {
  const run = await finishResearch(fixture)
  await fixture.prisma.channel.update({ where: { id: fixture.ids.channel }, data: { visibility: 'private' } })
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.equal(delivered.wakeMessageId, null, 'no run acts as someone who can no longer open the room')
  assert.deepEqual(await kickoffs(fixture), [])
  assert.deepEqual(await noticeKinds(fixture, run.id), ['wake_unreachable'])

  // Back in the room, a planner turn wakes the agent again.
  await fixture.prisma.channelMember.create({ data: { channelId: fixture.ids.channel, userId: fixture.ids.requester } })
  const brief = await fixture.insert('agent')
  const rs = researchId()
  const turnId = randomUUID()
  await fixture.attach(brief.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: turnId, seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_scope_get', wireScope({
    id: rs, turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'agent' }, revision: 1, withTranscript: true,
  }))
  await watch(fixture, brief.id)
  assert.equal((await fixture.read(brief.id)).agentWakeCount, 1)
  assert.deepEqual((await kickoffs(fixture)).map((message) => message.id), [deepWaterWakeKickoffId(brief.id, 'turn', turnId)])
})
