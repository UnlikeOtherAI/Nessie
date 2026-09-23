import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerScopeBrief, LedgerScopeResult } from '@nessie/schemas'

import { applyDeepWaterScopeResult } from '../src/deepwater-brief-projection.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import { toDeepWaterBriefView } from '../src/deepwater-brief-view.js'
import { insertBrief, personOrigin, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * The brief view after a reload (Water plan amendments N2): a planner failure
 * lives in register (b), never in the person's action, so a failed opening
 * turn still reads as failed and retryable once the page is reloaded — for a
 * brief opened bare (revision 0) and one seeded with pillars (revision 1).
 */

const runIfDatabase = process.env.DATABASE_URL ? test : test.skip

const withFixture = (name: string, body: (fixture: BriefFixture) => Promise<void>): void => {
  runIfDatabase(name, async () => {
    const fixture = await seedBriefFixture()
    try {
      await body(fixture)
    } finally {
      await fixture.cleanup()
    }
  })
}

const brief = (revision: number, pillars: string[]): LedgerScopeBrief => ({
  state: 'drafting',
  revision,
  topic: 'Heat pumps in older houses',
  reply: null,
  pillars,
  settings: {
    depth: 'light', chapterDepth: 'standard', searchQuality: 'standard', languages: [],
    outputLanguage: 'en', recency: 'any', writingStyle: 'standard',
  },
  lockedSettings: revision > 0 ? ['depth'] : [],
  openQuestions: [],
  analysis: null,
  ready: false,
  messages: null,
})

const failedOpening = (researchId: string, seed: LedgerScopeBrief): LedgerScopeResult => ({
  id: researchId,
  status: 'drafting',
  errorCode: null,
  title: null,
  brief: seed,
  turn: { id: randomUUID(), seq: 1, status: 'failed', authorKind: 'person', errorCode: 'planner_interrupted', retryable: true },
})

for (const [label, seed] of [
  ['unseeded (revision 0)', brief(0, [])],
  ['seeded (revision 1)', brief(1, ['Costs', 'Noise'])],
] as const) {
  withFixture(`a failed opening turn, ${label}, shows failed and retryable after a reload`, async (fixture) => {
    const origin = personOrigin()
    const { run } = await insertBrief(fixture, origin)
    const researchId = `rs_${randomUUID().replaceAll('-', '')}`
    // The opening's own ack reports the planner already failed.
    await fixture.prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, {
      organizationId: fixture.ids.organization,
      runId: run.id,
      result: failedOpening(researchId, seed),
      ackActionId: origin.kind === 'person' ? origin.actionId : null,
    }))

    // A reload reads the row afresh; nothing in memory carries the failure.
    const reloaded = await readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId: run.id })
    assert.ok(reloaded)
    const view = toDeepWaterBriefView(reloaded, {
      viewer: { userId: fixture.ids.requester, canChangeTeam: false },
      reportSpaceId: null,
      planner: { displayName: 'DeepWater', iconUrl: null },
    })
    assert.equal(view.status, 'drafting')
    assert.equal(view.plannerTurn.status, 'failed')
    assert.equal(view.plannerTurn.status === 'failed' && view.plannerTurn.retryable, true)
    assert.match(view.plannerTurn.status === 'failed' ? view.plannerTurn.message : '', /interrupted/)
    assert.equal(view.pendingAction, null, 'the failure ended the opening; it is not an action error')
    assert.equal(view.revision, seed.revision)
    assert.deepEqual(view.pillars, seed.pillars)
    // Sending the words again is the retry: the person may act on the brief.
    assert.equal(view.viewer.canEdit, true)
  })
}
