import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { clearDeepWaterDeliveryBlock } from '@nessie/runtime'
import { DeepWaterNoticeMessageMetadataSchema, LedgerResearchReportSchema } from '@nessie/schemas'

import {
  deepWaterReportPageId,
  ensureDeepWaterReportPage,
  resolveDeepWaterReportDestination,
  storeDeepWaterArtifacts,
} from '../../src/control/deepwater-report-import.js'
import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { retryDeepWaterDelivery } from '../../src/control/deepwater-worker.js'
import { researchId, seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The report's page in Documents (Water plan amendments N3, C11). Its id is
 * fixed by the run, so a page deleted or changed before the result was shared
 * can never be created again: delivery blocks once, with one notice naming the
 * remedy, and the person's Retry import puts the page back and delivers. A
 * conversation that is gone blocks the delivery too, but nothing can be posted
 * in it, so the notice's words only ever describe the page.
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

const wireReport = {
  report_markdown: '# Heat pumps\n\nThey work.',
  references: [{ title: 'Study', url: 'https://example.org/a', accessed_at: '2026-09-23T09:00:00.000Z' }],
  depth: 'light',
  started_at: '2026-09-23T09:00:00.000Z',
  completed_at: '2026-09-23T09:30:00.000Z',
  truncated: false,
  title: 'Heat pumps',
  report_kind: 'full',
}

/** A person's research that finished in Ledger and has not been delivered. */
const finishedResearch = async (fixture: WatchFixture) => {
  const run = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', wireReport)
  return run
}

/** An earlier attempt imported the page and stopped before its claim (a crash). */
const importPageOnly = async (fixture: WatchFixture, runId: string): Promise<string> => {
  const report = LedgerResearchReportSchema.parse(wireReport)
  const destination = await resolveDeepWaterReportDestination(fixture.prisma, await fixture.read(runId))
  assert.ok(destination)
  const files = await storeDeepWaterArtifacts(fixture.deps, await fixture.read(runId), {
    report, title: 'Heat pumps', projectId: destination.projectId,
  })
  const page = await ensureDeepWaterReportPage(fixture.deps, await fixture.read(runId), {
    destination, reportFileId: files.reportFileId, report, title: 'Heat pumps',
  })
  assert.equal(page.kind, 'ok')
  return deepWaterReportPageId(fixture.ids.organization, runId)
}

const notices = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread }, orderBy: { createdAt: 'asc' } }))
    .flatMap((message) => {
      const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
      return notice.success && notice.data.deepWaterNotice.runId === runId
        ? [{ kind: notice.data.deepWaterNotice.kind, content: message.content }]
        : []
    })

const retry = async (fixture: WatchFixture, runId: string) => {
  // What `POST …/:runId/deliver` does: clear the block, then enqueue the retry
  // with the person's live identity.
  assert.equal(
    await fixture.prisma.$transaction((tx) => clearDeepWaterDeliveryBlock(tx, { organizationId: fixture.ids.organization, runId })),
    true,
  )
  await retryDeepWaterDelivery(fixture.deps, {
    organizationId: fixture.ids.organization,
    runId,
    actionId: randomUUID(),
    identity: fixture.identity,
  })
}

const pageChanges = {
  // What the Knowledge delete route does to a page: `archivePage`.
  deleted: { status: 'archived' as const },
  changed: { metadata: { note: 'kept by hand' } },
}

for (const [how, change] of Object.entries(pageChanges)) {
  withFixture(`a report page ${how} in Documents blocks once, and Retry import puts it back`, async (fixture) => {
    const run = await finishedResearch(fixture)
    const pageId = await importPageOnly(fixture, run.id)
    await fixture.prisma.knowledgePage.update({ where: { id: pageId }, data: change })

    await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
    await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
    const blocked = await fixture.read(run.id)
    assert.equal(blocked.deliveryBlockedReason, 'knowledge_destination_unavailable')
    assert.equal(blocked.status, 'running', 'kept open for the retry')
    assert.equal(blocked.deliveredAt, null)
    const told = await notices(fixture, run.id)
    assert.deepEqual(told.map((notice) => notice.kind), ['blocked'])
    assert.match(told[0]?.content ?? '', /deleted or changed before the result could be shared/)
    assert.match(told[0]?.content ?? '', /Choose Retry import on the research to put the page back/)
    // The watch never undoes what was done to the page.
    const untouched = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
    assert.deepEqual({ status: untouched.status, marker: (untouched.metadata as Record<string, unknown>).deepWaterReport }, {
      status: how === 'deleted' ? 'archived' : 'draft',
      marker: how === 'deleted' ? { runId: run.id, reportFileId: blocked.reportFileId } : undefined,
    })

    await retry(fixture, run.id)
    const delivered = await fixture.read(run.id)
    assert.equal(delivered.status, 'completed')
    assert.ok(delivered.deliveredAt)
    assert.equal(delivered.knowledgePageId, pageId, 'the same page, never a second one')
    const page = await fixture.prisma.knowledgePage.findUniqueOrThrow({ where: { id: pageId } })
    assert.equal(page.deletedAt, null)
    assert.equal(page.status, 'draft')
    assert.deepEqual(
      (page.metadata as Record<string, unknown>).deepWaterReport,
      { runId: run.id, reportFileId: delivered.reportFileId },
    )
    if (how === 'changed') assert.equal((page.metadata as Record<string, unknown>).note, 'kept by hand')
    assert.equal(await fixture.prisma.knowledgePage.count({ where: { organizationId: fixture.ids.organization } }), 1)
    assert.deepEqual((await notices(fixture, run.id)).map((notice) => notice.kind), ['blocked', 'result'])
  })
}

withFixture('a delivery whose conversation is gone blocks without a notice', async (fixture) => {
  const run = await finishedResearch(fixture)
  await fixture.prisma.channel.update({ where: { id: fixture.ids.channel }, data: { deletedAt: new Date() } })
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))

  const blocked = await fixture.read(run.id)
  assert.equal(blocked.deliveryBlockedReason, 'knowledge_destination_unavailable')
  assert.equal(blocked.deliveredAt, null)
  assert.deepEqual(await notices(fixture, run.id), [], 'nothing can be posted in a conversation that is gone')
  assert.equal(await fixture.prisma.knowledgePage.count({ where: { organizationId: fixture.ids.organization } }), 0)
})
