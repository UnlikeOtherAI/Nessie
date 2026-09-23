import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  DeepWaterDeliveryMessageMetadataSchema,
  deepWaterScopeStartLedgerArgs,
  type RunExecuteJobPayload,
} from '@nessie/schemas'

import { renewDeepWaterIdentity } from '../../src/control/deepwater-delivery.js'
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

withFixture('a replay repeats the opening call\'s own arguments, built by the one builder', async (fixture) => {
  // Ledger fingerprints a scope start and answers a replay whose arguments
  // normalise differently with `conflict`; the opening call and every replay
  // are built from the stored input by `deepWaterScopeStartLedgerArgs`.
  const run = await fixture.insert('agent', { toolCallId: 'call_scope_start_args' })
  const input = {
    schemaVersion: 1,
    topic: 'Heat pumps in older houses',
    context: 'Solid brick, no cavity.',
    pillars: ['Costs', 'Noise'],
    settings: { depth: 'deep', chapterDepth: 'detailed', languages: ['cs', 'en'], outputLanguage: 'en' },
    originRootMessageId: null,
  } as const
  await fixture.prisma.productIntegrationRun.update({ where: { id: run.id }, data: { input } })
  fixture.ledger.answer('research_scope_start', wireScope({ id: researchId() }))
  await watch(fixture, run.id)

  const [call] = fixture.ledger.calls
  assert.deepEqual(call?.args, deepWaterScopeStartLedgerArgs(input))
  assert.deepEqual(call?.args, {
    topic: 'Heat pumps in older houses',
    context: 'Solid brick, no cavity.',
    pillars: ['Costs', 'Noise'],
    settings: { depth: 'deep', chapter_depth: 'detailed', languages: ['cs', 'en'], output_language: 'en' },
  })
})

withFixture('a replay Ledger answers with conflict is not a refusal: its live brief is never failed', async (fixture) => {
  const run = await fixture.insert('agent')
  fixture.ledger.answer('research_scope_start', {
    error: 'conflict',
    error_description: 'research_scope_start was already used with different input',
    status_code: 409,
  }, false)
  await watch(fixture, run.id)

  const kept = await fixture.read(run.id)
  assert.equal(kept.status, 'queued', 'left for the reap, never reported as refused')
  assert.equal(kept.failureCode, null)
  assert.deepEqual(await kickoffs(fixture), [], 'the agent is not told a brief Ledger holds was refused')
  // The same call would only get the same answer: the next read is due when
  // the confirm window closes, which the unattached claim never admits.
  assert.equal(kept.reconcileAfter.getTime(), kept.createdAt.getTime() + 24 * 3_600_000)
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
    title: 'Tepelná čerpadla ve starých domech',
    report_kind: 'full',
    full_report_error_code: null,
    public_url: null,
  })
  await watch(fixture, run.id)
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.equal(delivered.title, 'Tepelná čerpadla ve starých domech', 'the report\'s own title is kept')
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
  // Stored under the names the admin downloads them as, accents folded, never split.
  const files = await fixture.prisma.attachment.findMany({
    where: { id: { in: [delivered.reportFileId, delivered.sourcesFileId] } },
    select: { id: true, filename: true, mime: true },
  })
  assert.deepEqual(
    files.map((file) => [file.id === delivered.reportFileId ? 'report' : 'sources', file.filename, file.mime]).sort(),
    [
      ['report', 'tepelna-cerpadla-ve-starych-domech.md', 'text/markdown'],
      ['sources', 'tepelna-cerpadla-ve-starych-domech.csv', 'text/csv'],
    ],
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

withFixture('an agent\'s brief whose requester\'s sign-in changed tells them once, and a renewed sign-in resumes it', async (fixture) => {
  const brief = await fixture.insert('agent')
  const rs = researchId()
  const turnId = randomUUID()
  await fixture.attach(brief.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: turnId, seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
  })
  fixture.failIdentity(true)
  await watch(fixture, brief.id)
  await watch(fixture, brief.id)

  const blocked = await fixture.read(brief.id)
  assert.equal(blocked.deliveryBlockedReason, 'requester_identity_changed')
  assert.equal(blocked.status, 'drafting')
  assert.equal(fixture.ledger.calls.length, 0, 'nothing reaches Ledger without the identity')
  assert.deepEqual(await kickoffs(fixture), [], 'the agent cannot be woken as someone who is not signed in')
  // The person cannot edit an agent's brief and the agent is not woken again, so they are told — once.
  assert.deepEqual(await noticeKinds(fixture, brief.id), ['blocked'])
  const [notice] = await fixture.prisma.message.findMany({
    where: { threadId: fixture.ids.thread, role: 'assistant', agentId: null },
  })
  assert.match(notice?.content ?? '', /can't carry on because your sign-in has changed/)
  assert.match(notice?.content ?? '', /Sign in again, then choose Retry/)
  assert.equal(
    await fixture.prisma.userAlert.count({ where: { userId: fixture.ids.requester, messageId: notice?.id ?? '' } }),
    1,
    'the notice alerts the requester',
  )

  // Their next live identity renews the brief's and clears the block; the watch resumes.
  fixture.failIdentity(false)
  await renewDeepWaterIdentity(fixture.deps, {
    organizationId: fixture.ids.organization,
    runId: brief.id,
    identity: { ...fixture.identity, tokenVersion: fixture.identity.tokenVersion + 1 },
  })
  assert.equal((await fixture.read(brief.id)).deliveryBlockedReason, null)
  fixture.ledger.answer('research_scope_get', wireScope({
    id: rs, turn: { id: turnId, seq: 1, status: 'complete', author_kind: 'agent' }, revision: 1, withTranscript: true,
  }))
  await watch(fixture, brief.id)
  assert.equal((await fixture.read(brief.id)).agentWakeCount, 1)
  assert.deepEqual((await kickoffs(fixture)).map((message) => message.id), [deepWaterWakeKickoffId(brief.id, 'turn', turnId)])
})

withFixture('a failed planner turn wakes its agent to try again; past eight wakes the person is told once', async (fixture) => {
  const brief = await fixture.insert('agent')
  const rs = researchId()
  await fixture.attach(brief.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
  })
  const failed = { id: randomUUID(), seq: 2, status: 'failed', author_kind: 'agent' as const, retryable: true }
  fixture.ledger.answer('research_scope_get', (args) => ({
    ...wireScope({ id: rs, revision: 1, withTranscript: args.include_transcript === true }),
    turn: { ...failed, error_code: 'planner_unavailable' },
  }))
  await watch(fixture, brief.id)

  const [kickoff] = await kickoffs(fixture)
  assert.equal(kickoff?.id, deepWaterWakeKickoffId(brief.id, 'turn', failed.id))
  assert.match(kickoff?.content ?? '', /could not answer the brief/)
  assert.match(kickoff?.content ?? '', /Send your reply again with mcp_research_scope_reply/)
  assert.doesNotMatch(kickoff?.content ?? '', /planner_unavailable/, 'a kickoff never quotes the error code')
  assert.equal((await fixture.read(brief.id)).agentWakeCount, 1)

  // The eighth wake was the last: the next answers tell the person once instead.
  await fixture.prisma.productIntegrationRun.update({ where: { id: brief.id }, data: { agentWakeCount: 8 } })
  for (const seq of [3, 4]) {
    const turn = { id: randomUUID(), seq, status: 'complete', author_kind: 'agent' as const }
    fixture.ledger.answer('research_scope_get', (args) =>
      wireScope({ id: rs, turn, revision: seq, withTranscript: args.include_transcript === true }))
    await watch(fixture, brief.id)
  }
  const capped = await fixture.read(brief.id)
  assert.equal(capped.agentWakeCount, 8)
  assert.equal(capped.lastHandledTurnSeq, 4)
  assert.ok(capped.wakeCapNoticeAt)
  assert.equal((await kickoffs(fixture)).length, 1, 'no wake past the cap')
  assert.deepEqual(await noticeKinds(fixture, brief.id), ['wake_cap'])
})
