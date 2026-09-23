import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient, type Prisma } from '@prisma/client'
import { DeepWaterNoticeMessageMetadataSchema } from '@nessie/schemas'

import { deepWaterReportPageId } from '../../src/control/deepwater-report-import.js'
import { watchDeepWaterRun, type DeepWaterWatchDeps } from '../../src/control/deepwater-watch.js'
import { researchId, seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * Delivery is idempotent however it is interrupted (Water plan amendments N3):
 * a crash after reading the report (A1), after storing its artifacts (A2),
 * after importing the page (A3, the state B's rollback leaves), or on the far
 * side of B's commit, and the same run watched twice at once — each ends with
 * exactly one page, one result message, one delivered run, one alert and one
 * of each artifact.
 */

type CrashPoint = 'after-read' | 'after-artifacts' | 'before-claim-commit' | 'after-claim-commit'

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

const bind = <T extends object>(target: T, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop, target)
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
}

/** The watch's deps, with one crash armed at `point`. It fires once. */
const crashingDeps = (fixture: WatchFixture, point: CrashPoint, runId: string): DeepWaterWatchDeps => {
  let armed = true
  const fire = (): never => {
    armed = false
    throw new Error(`injected crash (${point})`)
  }
  const pageId = deepWaterReportPageId(fixture.ids.organization, runId)
  const prisma = new Proxy(fixture.prisma, {
    get(target, prop) {
      if (prop === '$transaction') {
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          const result = await target.$transaction(async (tx) => {
            const value = await work(tx)
            // Only the claim's transaction ends as `delivered`.
            if (armed && point === 'before-claim-commit' && value === 'delivered') fire()
            return value
          })
          if (armed && point === 'after-claim-commit' && result === 'delivered') fire()
          return result
        }
      }
      if (prop === 'knowledgePage' && point === 'after-artifacts') {
        // A3 begins by looking for the run's own page.
        return new Proxy(target.knowledgePage, {
          get(delegate, method) {
            if (method !== 'findFirst') return bind(delegate, method)
            return (args: { where?: { id?: string } }) =>
              armed && args.where?.id === pageId ? fire() : delegate.findFirst(args as never)
          },
        })
      }
      return bind(target, prop)
    },
  })
  const fileService: DeepWaterWatchDeps['fileService'] = {
    ...fixture.deps.fileService,
    store: async (input) => {
      if (armed && point === 'after-read') fire()
      return fixture.deps.fileService.store(input)
    },
  }
  return { ...fixture.deps, prisma, fileService }
}

const finishedResearch = async (fixture: WatchFixture) => {
  const run = await fixture.insert('person')
  const rs = researchId()
  await fixture.attach(run.id, {
    id: rs, status: 'running', errorCode: null, title: 'Heat pumps', brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  fixture.ledger.answer('research_status', { id: rs, status: 'complete', title: 'Heat pumps', error_code: null })
  fixture.ledger.answer('research_report', {
    report_markdown: '# Heat pumps\n\nThey work.',
    references: [{ title: 'Study', url: 'https://example.org/a', accessed_at: '2026-09-23T09:00:00.000Z' }],
    depth: 'light',
    started_at: '2026-09-23T09:00:00.000Z',
    completed_at: '2026-09-23T09:30:00.000Z',
    truncated: false,
    title: 'Heat pumps',
    report_kind: 'full',
  })
  return run
}

/** Exactly one of everything a delivery makes, and nothing else. */
const assertDeliveredOnce = async (fixture: WatchFixture, runId: string) => {
  const run = await fixture.read(runId)
  assert.equal(run.status, 'completed')
  assert.ok(run.deliveredAt)
  assert.equal(run.deliveryBlockedReason, null)
  assert.equal(
    await fixture.prisma.knowledgePage.count({ where: { organizationId: fixture.ids.organization, deletedAt: null } }),
    1,
    'one report page',
  )
  assert.equal(run.knowledgePageId, deepWaterReportPageId(fixture.ids.organization, runId))
  const results = (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread } }))
    .filter((message) => DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata).success)
  assert.deepEqual(results.map((message) => message.id), [run.resultMessageId], 'one result reply')
  assert.equal(
    await fixture.prisma.userAlert.count({ where: { eventKey: `deep-water-result:${runId}` } }),
    1,
    'one alert',
  )
  const attachments = await fixture.prisma.attachment.findMany({
    where: { organizationId: fixture.ids.organization },
    select: { id: true },
  })
  assert.deepEqual(
    attachments.map((attachment) => attachment.id).sort(),
    [run.reportFileId, run.sourcesFileId].sort(),
    'one report.md and one sources.csv',
  )
}

for (const point of ['after-read', 'after-artifacts', 'before-claim-commit', 'after-claim-commit'] as const) {
  withFixture(`a delivery interrupted ${point} completes once on the next watch`, async (fixture) => {
    const run = await finishedResearch(fixture)
    await assert.rejects(
      watchDeepWaterRun(crashingDeps(fixture, point, run.id), await fixture.read(run.id)),
      new RegExp(`injected crash \\(${point}\\)`),
    )
    const interrupted = await fixture.read(run.id)
    const pages = await fixture.prisma.knowledgePage.count({ where: { organizationId: fixture.ids.organization } })
    // Each crash fired where it was aimed.
    const reached = {
      'after-read': { artifacts: false, page: false },
      'after-artifacts': { artifacts: true, page: false },
      'before-claim-commit': { artifacts: true, page: true },
      'after-claim-commit': { artifacts: true, page: true },
    }[point]
    assert.equal(interrupted.reportFileId !== null && interrupted.sourcesFileId !== null, reached.artifacts)
    assert.equal(pages, reached.page ? 1 : 0)
    if (point === 'after-claim-commit') {
      assert.ok(interrupted.deliveredAt, 'the claim committed before the crash')
    } else {
      assert.equal(interrupted.deliveredAt, null, 'nothing terminal committed')
      assert.equal(interrupted.resultMessageId, null)
      assert.equal(interrupted.status, 'running', 'the watch will read it again')
    }
    // The next claim's watch — whatever the crash left, delivery ends once.
    await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
    await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))
    await assertDeliveredOnce(fixture, run.id)
  })
}

withFixture('the same run watched twice at once is delivered once', async (fixture) => {
  const run = await finishedResearch(fixture)
  const snapshot = await fixture.read(run.id)
  await Promise.all([watchDeepWaterRun(fixture.deps, snapshot), watchDeepWaterRun(fixture.deps, snapshot)])
  await assertDeliveredOnce(fixture, run.id)
})
