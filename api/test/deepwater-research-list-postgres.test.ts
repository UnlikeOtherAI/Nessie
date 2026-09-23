import assert from 'node:assert/strict'

import { decodeKeysetCursor, type AuthorizedActionContext } from '@nessie/schemas'

import { resolveDeepWaterResearchViewer } from '../src/services/deepwater-research-access.js'
import { listVisibleDeepWaterRuns } from '../src/services/deepwater-research-list.js'
import { RUNS, open, withBriefApi, type BriefApiFixture } from './deepwater-research-runs-fixture.js'

/**
 * The research list reads a bounded number of rows per request (Water plan
 * nessie.md §7.1): rows a viewer may not see are skipped, a page the bound cut
 * short says `hasMore` with a cursor after the last row read, and paging on
 * from it reaches every visible run exactly once.
 */

type Row = { id: string; visible: boolean }

/**
 * The requester's briefs, oldest first, a second apart. A visible one has
 * been launched, so a colleague in the room sees it; a hidden one is still
 * being agreed, which is the requester's alone.
 */
const seedRuns = async (fixture: BriefApiFixture, visibility: boolean[]): Promise<Row[]> => {
  const base = Date.parse('2026-09-01T09:00:00.000Z')
  const rows: Row[] = []
  for (const [index, visible] of visibility.entries()) {
    const { runId } = await open(fixture)
    await fixture.prisma.productIntegrationRun.update({
      where: { id: runId },
      data: {
        createdAt: new Date(base + index * 1_000),
        ...(visible ? { status: 'running', launchedAt: new Date(base + index * 1_000) } : {}),
      },
    })
    rows.push({ id: runId, visible })
  }
  return rows
}

const colleagueContext = (fixture: BriefApiFixture) => ({
  actionContext: { requestId: 'list', teamId: fixture.ids.team },
  actor: { actorId: fixture.ids.colleague, actorType: 'user', roles: ['member'] },
  tenant: { organizationId: fixture.ids.organization, projectId: fixture.ids.project, teamId: fixture.ids.team },
}) as unknown as AuthorizedActionContext

withBriefApi('a page the read bound cut short carries on after the last row read, skipping no visible run', async (fixture) => {
  // Newest first: V3, five hidden, V2, V1.
  const rows = await seedRuns(fixture, [true, true, false, false, false, false, false, true])
  const newestFirst = [...rows].reverse()
  const visible = newestFirst.filter((row) => row.visible).map((row) => row.id)
  const viewer = await resolveDeepWaterResearchViewer(fixture.prisma, colleagueContext(fixture))
  const bounds = { batch: 2, maxBatches: 2 }
  const page = (cursor: ReturnType<typeof decodeKeysetCursor>) =>
    listVisibleDeepWaterRuns(fixture.prisma, viewer, { teamId: fixture.ids.team, limit: 2, cursor }, bounds)

  // Four rows read — V3 and three hidden — so the page is short, and says there is more.
  const first = await page(null)
  assert.deepEqual(first.runs.map((run) => run.id), [visible[0]])
  assert.equal(first.hasMore, true)
  assert.equal(first.nextCursor?.id, newestFirst[3]?.id, 'the cursor is the last row read, not the last one shown')

  // Two more hidden, then V2 and V1: the page is full, but the bound stops the read before it can know it is the last.
  const second = await page(first.nextCursor)
  assert.deepEqual(second.runs.map((run) => run.id), [visible[1], visible[2]])
  assert.equal(second.hasMore, true)
  assert.equal(second.nextCursor?.id, visible[2])

  const third = await page(second.nextCursor)
  assert.deepEqual(third, { runs: [], hasMore: false, nextCursor: null })
})

withBriefApi('the list route pages past runs the viewer may not see, and ends where the runs end', async (fixture) => {
  // Newest first: V2, two hidden, V1.
  const rows = await seedRuns(fixture, [true, false, false, true])
  const [v1, , , v2] = rows
  fixture.actAs('colleague')

  const first = await fixture.request('GET', `${RUNS}?limit=1`)
  assert.deepEqual((first.body.data?.items as Array<{ id: string }>).map((item) => item.id), [v2?.id])
  const meta = first.body.data?.meta as { hasMore: boolean; nextCursor: string | null }
  assert.equal(meta.hasMore, true)
  assert.ok(meta.nextCursor)

  const second = await fixture.request('GET', `${RUNS}?limit=1&cursor=${encodeURIComponent(meta.nextCursor)}`)
  assert.deepEqual((second.body.data?.items as Array<{ id: string }>).map((item) => item.id), [v1?.id])
  assert.deepEqual(second.body.data?.meta, { hasMore: false, nextCursor: null, prevCursor: null })

  // The requester sees all four, their briefs still being agreed included.
  fixture.actAs('requester')
  const own = await fixture.request('GET', `${RUNS}?limit=10`)
  assert.equal((own.body.data?.items as unknown[]).length, 4)
})
