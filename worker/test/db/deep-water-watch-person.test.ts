import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { DeepWaterNoticeMessageMetadataSchema, PushDispatchJobPayloadSchema } from '@nessie/schemas'

import { reapUnconfirmedDeepWaterBriefs } from '../../src/control/deepwater-worker.js'
import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The watch for a brief a person started (Water plan amendments-fable F1, F4,
 * amendments N3, N5): the finished research comes back as one result reply
 * under the research card with one alert; a delivery that cannot finish is
 * blocked once with one notice naming the remedy; a changed sign-in stops a
 * brief quietly and tells a launched research's requester; a failed research
 * and a brief never confirmed are told once.
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

const launched = async (fixture: WatchFixture) => {
  const run = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  return { run, rs }
}

const notices = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread }, orderBy: { createdAt: 'asc' } }))
    .flatMap((message) => {
      const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
      return notice.success && notice.data.deepWaterNotice.runId === runId
        ? [{ ...message, kind: notice.data.deepWaterNotice.kind }]
        : []
    })

/** Notices about a run, wherever they landed. */
const noticesAnywhere = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({
    where: { threadId: { in: [fixture.ids.thread, fixture.ids.assistantThread] } },
    orderBy: { createdAt: 'asc' },
  })).flatMap((message) => {
    const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
    return notice.success && notice.data.deepWaterNotice.runId === runId
      ? [{ ...message, kind: notice.data.deepWaterNotice.kind }]
      : []
  })

const report = {
  report_markdown: '# Heat pumps\n\nThey work.',
  references: [],
  depth: 'light',
  started_at: '2026-09-23T09:00:00.000Z',
  completed_at: '2026-09-23T09:30:00.000Z',
  truncated: true,
  title: 'Heat pumps',
  report_kind: 'summary',
  full_report_error_code: 'under_min_word_count',
  public_url: 'https://research.deepwater.live/heat-pumps-6f1c2d3e',
}

withFixture('a finished research comes back as one result reply under the card, with one alert', async (fixture) => {
  const { run, rs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', report)
  await watch(fixture, run.id)
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.equal(delivered.reportKind, 'summary')
  assert.equal(delivered.reportTruncated, true)
  assert.equal(delivered.publicUrl, report.public_url)
  const card = await fixture.prisma.message.findUniqueOrThrow({ where: { id: delivered.cardMessageId ?? '' } })
  assert.equal(card.role, 'user')
  assert.equal(card.userId, fixture.ids.requester)
  const [reply, ...others] = await notices(fixture, run.id)
  assert.equal(others.length, 0)
  assert.equal(reply?.kind, 'result')
  assert.equal(reply?.id, delivered.resultMessageId)
  assert.equal(reply?.rootMessageId, card.id)
  assert.match(reply?.content ?? '', /research summary/)
  assert.match(reply?.content ?? '', /end of it is missing/)
  const alerts = await fixture.prisma.userAlert.findMany({ where: { messageId: reply?.id } })
  assert.deepEqual(alerts.map((alert) => [alert.userId, alert.eventKey]), [[fixture.ids.requester, `deep-water-result:${run.id}`]])
  // Their devices ring too, queued with the reply: addressed to them alone, as a mention.
  const pushes = await fixture.prisma.queueJob.findMany({
    where: { topic: 'push.dispatch', payload: { path: ['messageId'], equals: reply?.id ?? '' } },
  })
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]?.idempotencyKey, `push:${reply?.id}`)
  const push = PushDispatchJobPayloadSchema.parse(pushes[0]?.payload)
  assert.deepEqual(push.recipientUserIds, [fixture.ids.requester])
  assert.deepEqual(push.mentionUserIds, [fixture.ids.requester])
  assert.equal(push.rootMessageId, card.id)
  assert.equal(push.authorName, 'DeepWater')
  assert.equal(push.contentVisibility, undefined, 'a public room with no private sources shows the words')
  // The notice's own words, without a link target, cut to a lock screen's length.
  assert.ok((reply?.content ?? '').replace(/\]\([^)]*\)/g, '').replace(/\[/g, '').startsWith(push.contentSnippet))
  assert.equal(push.contentSnippet.length, 140)
  assert.doesNotMatch(push.contentSnippet, /knowledge-base|\]\(/)
  const page = await fixture.prisma.knowledgePage.findUniqueOrThrow({
    where: { id: delivered.knowledgePageId ?? '' },
    include: { versions: true },
  })
  assert.match(page.versions[0]?.body ?? '', /^> DeepWater could not write the full report/)
  // A summary never downloads under the full report's name.
  const reportFile = await fixture.prisma.attachment.findUniqueOrThrow({ where: { id: delivered.reportFileId ?? '' } })
  assert.equal(reportFile.filename, 'heat-pumps-summary.md')

  // Announced after commit (nessie.md §7.7, C3): the card, the reply under it,
  // the requester's alert, and the run on the requester's and the room's lanes.
  const events = fixture.realtime.published
  const cardEvent = events.find((event) => event.event === 'message.new' && (event.data as { messageId: string }).messageId === card.id)
  assert.ok(cardEvent, 'the card appears without a reload')
  const replyEvent = events.find((event) => event.event === 'message.reply')
  assert.equal((replyEvent?.data as { messageId?: string } | undefined)?.messageId, reply?.id)
  assert.equal((replyEvent?.data as { rootMessageId?: string } | undefined)?.rootMessageId, card.id)
  assert.equal(replyEvent?.idempotencyKey, `deep-water:message:${reply?.id}`)
  assert.ok(events.some((event) => event.event === 'message.reply.meta'))
  const alertEvents = events.filter((event) => event.event === 'alert.created')
  assert.deepEqual(alertEvents.map((event) => event.idempotencyKey), [`deep-water-result:${run.id}:${fixture.ids.requester}`])
  const runEvents = events.filter((event) => event.event === 'integration.run.updated')
  assert.ok(runEvents.every((event) => JSON.stringify(event.data) === JSON.stringify({ productSlug: 'deep-water', runId: run.id })))
  assert.ok(runEvents.some((event) => event.scopes.some((scope) => scope.kind === 'user' && scope.userId === fixture.ids.requester)))
  assert.ok(runEvents.some((event) => event.scopes.some((scope) => scope.kind === 'channel' && scope.channelId === fixture.ids.channel)))
})

withFixture('a realtime outage never undoes a delivery: the rows are the record', async (fixture) => {
  const { run, rs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', report)
  fixture.realtime.failPublishes(true)
  await watch(fixture, run.id)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.ok(delivered.deliveredAt && delivered.resultMessageId)
  assert.equal(fixture.realtime.published.length, 0)
  assert.deepEqual((await notices(fixture, run.id)).map((notice) => notice.kind), ['result'])
})

withFixture('a report that expired blocks delivery once, with one notice naming the remedy', async (fixture) => {
  const { run, rs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', { error: 'expired', error_description: 'gone', status_code: 410 }, false)
  await watch(fixture, run.id)
  await watch(fixture, run.id)

  const blocked = await fixture.read(run.id)
  assert.equal(blocked.deliveryBlockedReason, 'report_expired')
  assert.equal(blocked.status, 'completed')
  assert.equal(blocked.deliveredAt, null)
  const posted = await notices(fixture, run.id)
  assert.deepEqual(posted.map((notice) => notice.kind), ['blocked'])
  assert.match(posted[0]?.content ?? '', /no longer available/)
})

withFixture('a changed sign-in stops a brief quietly and tells a launched research\'s requester', async (fixture) => {
  const brief = await fixture.insert('person')
  await fixture.attach(brief.id, {
    id: researchId(), status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'person', errorCode: null, retryable: false },
  })
  const { run: research } = await launched(fixture)
  fixture.failIdentity(true)
  await watch(fixture, brief.id)
  await watch(fixture, research.id)

  assert.equal((await fixture.read(brief.id)).deliveryBlockedReason, 'requester_identity_changed')
  assert.equal((await fixture.read(brief.id)).status, 'drafting')
  assert.deepEqual(await notices(fixture, brief.id), [])
  assert.equal((await fixture.read(research.id)).deliveryBlockedReason, 'requester_identity_changed')
  assert.equal((await fixture.read(research.id)).status, 'running', 'kept open so a retry can deliver it')
  const told = await notices(fixture, research.id)
  assert.deepEqual(told.map((notice) => notice.kind), ['blocked'])
  // Still running: nothing finished and nothing failed to save.
  assert.match(told[0]?.content ?? '', /can't check on your research/)
  assert.match(told[0]?.content ?? '', /sign-in has changed/)
  assert.doesNotMatch(told[0]?.content ?? '', /has finished|saved to Documents/)
  assert.equal(fixture.ledger.calls.length, 0, 'nothing reaches Ledger without the identity')
})

withFixture('a failed research and a brief never confirmed are each told once', async (fixture) => {
  const { run: failed, rs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: rs, status: 'failed', title: null, error_code: 'upstream_failed' })
  await watch(fixture, failed.id)
  await watch(fixture, failed.id)
  const delivered = await fixture.read(failed.id)
  assert.equal(delivered.status, 'failed')
  assert.equal(delivered.failureCode, 'upstream_failed')
  assert.ok(delivered.deliveredAt)
  const told = await notices(fixture, failed.id)
  assert.deepEqual(told.map((notice) => notice.kind), ['failed'])
  assert.match(told[0]?.content ?? '', /didn’t finish|didn't finish/)

  const unconfirmed = await fixture.insert('person')
  await fixture.prisma.productIntegrationRun.update({
    where: { id: unconfirmed.id },
    data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
  })
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  assert.equal((await fixture.read(unconfirmed.id)).failureCode, 'start_unconfirmed')
  // Never launched, so never the room's: told in their own conversation.
  const reaped = await noticesAnywhere(fixture, unconfirmed.id)
  assert.deepEqual(reaped.map((notice) => [notice.kind, notice.threadId]), [['start_unconfirmed', fixture.ids.assistantThread]])
})

const basisOf = async (fixture: WatchFixture, messageId: string) =>
  (await fixture.prisma.messageBasisScope.findMany({ where: { messageId }, select: { scopeType: true, scopeId: true } }))
    .map((scope) => `${scope.scopeType}:${scope.scopeId}`)

withFixture('a person\'s brief the room never saw is told to them alone, in their own conversation', async (fixture) => {
  // Refused by DeepWater while it was still being agreed: the room never saw it.
  const refused = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(refused.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'person', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_scope_get', { ...wireScope({ id: rs }), status: 'failed', error_code: 'scope_rejected' })
  await watch(fixture, refused.id)
  const [told, ...more] = await noticesAnywhere(fixture, refused.id)
  assert.equal(more.length, 0)
  assert.equal(told?.kind, 'failed')
  assert.equal(told?.threadId, fixture.ids.assistantThread, 'told where only they read')
  assert.equal(told?.rootMessageId, null)
  assert.equal((await fixture.read(refused.id)).cardMessageId, null)
  assert.equal((await fixture.read(refused.id)).launchedAt, null)
  // The room has nothing: no placeholder, no reply count, no alert.
  assert.equal(await fixture.prisma.message.count({ where: { threadId: fixture.ids.thread } }), 0)
  const alerts = await fixture.prisma.userAlert.findMany({ where: { messageId: told?.id } })
  assert.deepEqual(alerts.map((alert) => [alert.userId, alert.channelId]), [[fixture.ids.requester, fixture.ids.assistantChannel]])
  const [push] = await fixture.prisma.queueJob.findMany({
    where: { topic: 'push.dispatch', payload: { path: ['messageId'], equals: told?.id ?? '' } },
  })
  assert.equal(PushDispatchJobPayloadSchema.parse(push?.payload).channelId, fixture.ids.assistantChannel)
  const announced = fixture.realtime.published.find((event) =>
    event.event === 'message.new' && (event.data as { messageId: string }).messageId === told?.id)
  assert.ok(announced?.scopes.every((scope) => scope.kind !== 'channel' || scope.channelId === fixture.ids.assistantChannel))

  // Launched: its card already put the topic in the room, so its notice is the room's.
  const { run: launchedRun, rs: launchedRs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: launchedRs, status: 'failed', title: null, error_code: 'upstream_failed' })
  await watch(fixture, launchedRun.id)
  const [roomNotice] = await noticesAnywhere(fixture, launchedRun.id)
  assert.equal(roomNotice?.kind, 'failed')
  assert.equal(roomNotice?.threadId, fixture.ids.thread)
  assert.deepEqual(await basisOf(fixture, roomNotice?.id ?? ''), [])
})

withFixture('a brief that finished before the watch saw it run is shown to the room before its result', async (fixture) => {
  // The launch ack was lost and the research finished between two reads: the
  // watch's first sight of it is complete while the run still says drafting.
  const brief = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(brief.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_scope_get', { ...wireScope({ id: rs, revision: 2 }), status: 'complete', title: 'Heat pumps' })
  fixture.ledger.answer('research_report', report)
  await watch(fixture, brief.id)

  const delivered = await fixture.read(brief.id)
  assert.equal(delivered.status, 'completed')
  assert.ok(delivered.launchedAt, 'a finished research was launched')
  assert.ok(delivered.cardMessageId, 'the room is shown the research first')
  const [result, ...others] = await noticesAnywhere(fixture, brief.id)
  assert.equal(others.length, 0)
  assert.equal(result?.kind, 'result')
  assert.equal(result?.threadId, fixture.ids.thread)
  assert.equal(result?.rootMessageId, delivered.cardMessageId, 'the result lands under the card')
  assert.deepEqual(await basisOf(fixture, result?.id ?? ''), [])
})

withFixture('a brief refused before launch never counts as launched, whatever its status', async (fixture) => {
  const brief = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(brief.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  // A bare failure can be a refusal before launch: no card, nothing for the room.
  fixture.ledger.answer('research_scope_get', { ...wireScope({ id: rs, revision: 1 }), status: 'failed', error_code: 'upstream_failed' })
  await watch(fixture, brief.id)
  const failed = await fixture.read(brief.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.launchedAt, null)
  assert.equal(failed.cardMessageId, null)

  // One Ledger reports as launched before it failed is the room's.
  const launchedBrief = await fixture.insert('person')
  const launchedRs = researchId()
  await fixture.attach(launchedBrief.id, {
    id: launchedRs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  const wire = wireScope({ id: launchedRs, revision: 1 }) as { brief: Record<string, unknown> }
  fixture.ledger.answer('research_scope_get', {
    ...wire, brief: { ...wire.brief, state: 'launched' }, status: 'failed', error_code: 'upstream_failed',
  })
  await watch(fixture, launchedBrief.id)
  const told = await fixture.read(launchedBrief.id)
  assert.equal(told.status, 'failed')
  assert.ok(told.launchedAt && told.cardMessageId)
  const [notice] = await noticesAnywhere(fixture, launchedBrief.id)
  assert.equal(notice?.threadId, fixture.ids.thread)
  assert.equal(notice?.rootMessageId, told.cardMessageId)
})

withFixture('a read that fails while Ledger restarts is tried again within 30 s; a refusal waits', async (fixture) => {
  const { run } = await launched(fixture)
  // What the watch claim does to this run alone (a global claim here could take
  // another suite's due rows): the next sequence, backed off ten minutes.
  const claimNow = async () => {
    await fixture.prisma.productIntegrationRun.update({
      where: { id: run.id },
      data: { reconcileSeq: { increment: 1 }, reconcileAfter: new Date(Date.now() + 10 * 60_000) },
    })
    return fixture.read(run.id)
  }
  const nextReadIn = async () => (await fixture.read(run.id)).reconcileAfter.getTime() - Date.now()

  const claimed = await claimNow()
  assert.ok(claimed.reconcileAfter.getTime() - Date.now() > 9 * 60_000, 'the claim backs off')
  fixture.ledger.answer('research_status', { error: 'upstream_unavailable', status_code: 503 }, false)
  await watchDeepWaterRun(fixture.deps, claimed)
  const soon = await nextReadIn()
  assert.ok(soon > 20_000 && soon <= 30_000, `read again within 30 s (${soon} ms)`)

  await claimNow()
  fixture.ledger.answer('research_status', { error: 'forbidden', status_code: 403 }, false)
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
  assert.ok(await nextReadIn() > 9 * 60_000, 'a definitive refusal keeps the backoff')
  assert.equal((await fixture.read(run.id)).status, 'running')
  assert.equal(fixture.ledger.calls.filter((call) => call.toolName === 'research_status').length, 2)
  assert.deepEqual(
    fixture.ledger.calls.map((call) => call.toolCallId),
    [`watch:${run.id}:${claimed.reconcileSeq}`, `watch:${run.id}:${claimed.reconcileSeq + 1}`],
  )
})

withFixture('a report Ledger has not caught up with yet is read again, never blocked', async (fixture) => {
  const { run, rs } = await launched(fixture)
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', {
    error: 'not_ready',
    error_description: 'Research report is not ready',
    status_code: 409,
  }, false)
  await watch(fixture, run.id)

  const waiting = await fixture.read(run.id)
  assert.equal(waiting.status, 'running')
  assert.equal(waiting.deliveryBlockedReason, null)
  assert.equal(waiting.deliveredAt, null)
  assert.deepEqual(await notices(fixture, run.id), [])

  fixture.ledger.answer('research_report', report)
  await watch(fixture, run.id)
  assert.equal((await fixture.read(run.id)).status, 'completed')
  assert.deepEqual((await notices(fixture, run.id)).map((notice) => notice.kind), ['result'])
})
