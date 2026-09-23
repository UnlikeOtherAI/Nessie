import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { applyDeepWaterScopeResult } from '@nessie/runtime'
import { DeepWaterDeliveryMessageMetadataSchema, DeepWaterNoticeMessageMetadataSchema } from '@nessie/schemas'

import { runDeepWaterTransaction } from '../../src/control/deepwater-announce.js'
import { ensureDeepWaterResearchCard } from '../../src/control/deepwater-messages.js'
import { deepWaterWakeKickoffId } from '../../src/control/deepwater-wake.js'
import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { reapUnconfirmedDeepWaterBriefs } from '../../src/control/deepwater-worker.js'
import { researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * A brief the reap gave up that DeepWater confirms after all (Water plan
 * amendments N5 test "a reap followed by a revival and a completion"). Under
 * amendments-fable F1 the watch never re-reads a reaped row, so only a late
 * acknowledgement of the opening call — the person's brief-action job, or the
 * agent's own tool result — can revive it. The requester hears once that the
 * brief was not confirmed and then once that it finished: one notice, then one
 * delivery, however often the reap and the watch run.
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

const report = {
  report_markdown: '# Heat pumps\n\nThey work.',
  references: [],
  depth: 'light',
  started_at: '2026-09-23T09:00:00.000Z',
  completed_at: '2026-09-23T09:30:00.000Z',
  truncated: false,
  title: 'Heat pumps',
  report_kind: 'full',
}

/** A brief opened a day and more ago that DeepWater never confirmed, reaped twice. */
const reapedBrief = async (fixture: WatchFixture, origin: 'person' | 'agent') => {
  const run = await fixture.insert(origin)
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
  })
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  const reaped = await fixture.read(run.id)
  assert.equal(reaped.status, 'failed')
  assert.equal(reaped.failureCode, 'start_unconfirmed')
  return reaped
}

/** Ledger's research finished; the brief says it was launched. */
const finished = (rs: string) => {
  const wire = wireScope({ id: rs, revision: 2 }) as { brief: Record<string, unknown> }
  return { ...wire, brief: { ...wire.brief, state: 'launched' }, status: 'complete', title: 'Heat pumps' }
}

const noticesAnywhere = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({
    where: { threadId: { in: [fixture.ids.thread, fixture.ids.assistantThread] } },
    orderBy: { createdAt: 'asc' },
  })).flatMap((message) => {
    const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
    return notice.success && notice.data.deepWaterNotice.runId === runId ? [{ ...message, notice: notice.data }] : []
  })

withFixture('a person\'s reaped brief that DeepWater confirms late is told once, then delivered once', async (fixture) => {
  const run = await reapedBrief(fixture, 'person')
  const rs = researchId()

  // The opening action's late acknowledgement attaches the research: the reap is undone.
  await fixture.attach(run.id, {
    id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'person', errorCode: null, retryable: false },
  })
  const revived = await fixture.read(run.id)
  assert.equal(revived.status, 'drafting')
  assert.equal(revived.failureCode, null)
  assert.equal(revived.completedAt, null)
  assert.equal(revived.externalRunId, rs)
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)
  assert.equal((await fixture.read(run.id)).status, 'drafting', 'an attached brief is never reaped again')

  fixture.ledger.answer('research_scope_get', finished(rs))
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', report)
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  assert.ok(delivered.deliveredAt && delivered.cardMessageId)
  const told = await noticesAnywhere(fixture, run.id)
  assert.deepEqual(
    told.map((message) => [message.notice.deepWaterNotice.kind, message.threadId]),
    [['start_unconfirmed', fixture.ids.assistantThread], ['result', fixture.ids.thread]],
    'one notice where only they read, then one result under the card',
  )
  assert.equal(told[1]?.rootMessageId, delivered.cardMessageId)
  assert.equal(delivered.resultMessageId, told[1]?.id)
  const alerts = await fixture.prisma.userAlert.findMany({ where: { userId: fixture.ids.requester, messageId: { in: told.map((m) => m.id) } } })
  assert.equal(alerts.length, 2, 'one alert each')
  assert.equal(fixture.ledger.calls.filter((call) => call.toolName === 'research_report').length, 1)
})

withFixture('an agent\'s reaped brief that DeepWater confirms late wakes it once, then delivers once', async (fixture) => {
  const run = await reapedBrief(fixture, 'agent')
  const rs = researchId()

  // The agent's own tool result arrives late: the binder attaches it and posts the card.
  await runDeepWaterTransaction(fixture.deps, async (tx, announce) => {
    const outcome = await applyDeepWaterScopeResult(tx, {
      organizationId: fixture.ids.organization,
      runId: run.id,
      result: {
        id: rs, status: 'drafting', errorCode: null, title: null, brief: null,
        turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'agent', errorCode: null, retryable: false },
      },
      turnAuthor: { kind: 'agent', agentId: fixture.ids.agent },
    })
    assert.ok(outcome.applied && outcome.attached)
    await ensureDeepWaterResearchCard(tx, announce, { organizationId: fixture.ids.organization, runId: run.id })
  })
  assert.equal((await fixture.read(run.id)).status, 'drafting')

  fixture.ledger.answer('research_scope_get', finished(rs))
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', report)
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
  await reapUnconfirmedDeepWaterBriefs(fixture.deps, 500)

  const delivered = await fixture.read(run.id)
  assert.equal(delivered.status, 'completed')
  const kickoffs = await fixture.prisma.message.findMany({
    where: { threadId: fixture.ids.thread, role: 'system' },
    orderBy: { createdAt: 'asc' },
  })
  assert.deepEqual(
    kickoffs.map((message) => DeepWaterDeliveryMessageMetadataSchema.parse(message.metadata).deepWaterDelivery.kind),
    ['start_unconfirmed', 'completed'],
  )
  assert.equal(delivered.wakeMessageId, deepWaterWakeKickoffId(run.id, 'completed', null))
  assert.deepEqual(await noticesAnywhere(fixture, run.id), [], 'the agent was reached both times')
})
