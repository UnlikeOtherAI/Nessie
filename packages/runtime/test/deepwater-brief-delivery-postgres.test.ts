import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginDeepWaterPersonAction,
  failUnstartedDeepWaterBrief,
  settleDeepWaterPersonAction,
} from '../src/deepwater-brief-actions.js'
import {
  blockDeepWaterDelivery,
  claimDeepWaterDelivery,
  clearDeepWaterDeliveryBlock,
  recordDeepWaterArtifactFile,
  recordDeepWaterDeliveryMessage,
  type DeepWaterDeliveryOutcome,
} from '../src/deepwater-brief-delivery.js'
import {
  mayRefreshDeepWaterIdentity,
  refreshDeepWaterRunIdentity,
} from '../src/deepwater-brief-identity.js'
import { readDeepWaterBriefRun } from '../src/deepwater-brief-run-record.js'
import { loadDeepWaterOriginDestination } from '../src/deepwater-brief-viewer.js'
import { insertBrief, personOrigin, seedBriefFixture, type BriefFixture } from './deepwater-brief-fixture.js'

/**
 * Delivery, identity refresh and person actions against PostgreSQL: every
 * guarantee here is a conditional write, and only a real database shows a
 * second attempt finding the first one's receipt.
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

const read = (fixture: BriefFixture, runId: string) =>
  readDeepWaterBriefRun(fixture.prisma, { organizationId: fixture.ids.organization, runId })

const knowledgePage = async (fixture: BriefFixture): Promise<string> => {
  const spaceId = randomUUID()
  const pageId = randomUUID()
  await fixture.pool.query(
    `INSERT INTO knowledge_spaces (id, organization_id, project_id, name, created_by, updated_at)
     VALUES ($1, $2, $3, 'Research', 'test', now())`,
    [spaceId, fixture.ids.organization, fixture.ids.project],
  )
  await fixture.pool.query(
    `INSERT INTO knowledge_pages (id, organization_id, project_id, space_id, title, created_by, updated_at)
     VALUES ($1, $2, $3, $4, 'Heat pumps', 'test', now())`,
    [pageId, fixture.ids.organization, fixture.ids.project, spaceId],
  )
  return pageId
}

const attachment = async (fixture: BriefFixture): Promise<string> => {
  const id = randomUUID()
  await fixture.pool.query(
    `INSERT INTO attachments (id, organization_id, kind, mime, filename, size_bytes, storage_key)
     VALUES ($1, $2, 'file', 'text/markdown', 'report.md', 10, $3)`,
    [id, fixture.ids.organization, `test/${id}`],
  )
  return id
}

const completed = (knowledgePageId: string, overrides: Partial<DeepWaterDeliveryOutcome & { kind: 'completed' }> = {}) => ({
  kind: 'completed' as const,
  knowledgePageId,
  sourceCount: 41,
  reportKind: 'summary' as const,
  truncated: true,
  publicUrl: 'https://research.deepwater.live/heat-pumps-ab12cd',
  title: 'Heat pumps',
  ...overrides,
})

withFixture('delivery is claimed exactly once and records the result', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const pageId = await knowledgePage(fixture)
  const claim = () => fixture.prisma.$transaction((tx) => claimDeepWaterDelivery(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    outcome: completed(pageId),
  }))
  const outcomes = await Promise.all([claim(), claim(), claim()])
  assert.equal(outcomes.filter(Boolean).length, 1)
  const stored = await read(fixture, run.id)
  assert.equal(stored?.status, 'completed')
  assert.ok(stored?.deliveredAt)
  assert.equal(stored?.knowledgePageId, pageId)
  assert.equal(stored?.reportKind, 'summary')
  assert.equal(stored?.reportTruncated, true)
  assert.equal(stored?.publicUrl, 'https://research.deepwater.live/heat-pumps-ab12cd')
  assert.equal(stored?.sourceCount, 41)

  const other = (await insertBrief(fixture)).run.id
  await assert.rejects(
    fixture.prisma.$transaction((tx) => claimDeepWaterDelivery(tx, {
      organizationId: fixture.ids.organization,
      runId: other,
      outcome: completed(pageId, { publicUrl: 'https://evil.example/report' }),
    })),
    /research\.deepwater\.live/,
  )
})

withFixture('a failed research is delivered through the same claim', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const claimed = await fixture.prisma.$transaction((tx) => claimDeepWaterDelivery(tx, {
    organizationId: fixture.ids.organization,
    runId: run.id,
    outcome: { kind: 'failed', failureCode: 'upstream_failed' },
  }))
  assert.equal(claimed, true)
  const stored = await read(fixture, run.id)
  assert.equal(stored?.status, 'failed')
  assert.equal(stored?.failureCode, 'upstream_failed')
  assert.ok(stored?.deliveredAt)
})

withFixture('a block is set once, keeps a retryable run open and completes a final one', async (fixture) => {
  const block = (runId: string, reason: 'ledger_unavailable' | 'report_expired') =>
    fixture.prisma.$transaction((tx) => blockDeepWaterDelivery(tx, {
      organizationId: fixture.ids.organization, runId, reason,
    }))
  const clear = (runId: string) =>
    fixture.prisma.$transaction((tx) => clearDeepWaterDeliveryBlock(tx, {
      organizationId: fixture.ids.organization, runId,
    }))

  const { run: retryable } = await insertBrief(fixture)
  await fixture.pool.query(`UPDATE product_integration_runs SET status = 'running' WHERE id = $1`, [retryable.id])
  assert.equal(await block(retryable.id, 'ledger_unavailable'), true)
  assert.equal(await block(retryable.id, 'ledger_unavailable'), false, 'one notice per block')
  assert.equal((await read(fixture, retryable.id))?.status, 'running')
  // A blocked run cannot be delivered until the block is cleared.
  const pageId = await knowledgePage(fixture)
  const claim = () => fixture.prisma.$transaction((tx) => claimDeepWaterDelivery(tx, {
    organizationId: fixture.ids.organization, runId: retryable.id, outcome: completed(pageId),
  }))
  assert.equal(await claim(), false)
  assert.equal(await clear(retryable.id), true)
  assert.equal(await claim(), true)

  const { run: final } = await insertBrief(fixture)
  assert.equal(await block(final.id, 'report_expired'), true)
  assert.equal((await read(fixture, final.id))?.status, 'completed')
  assert.equal(await clear(final.id), false, 'no retry fixes an expired report')
})

withFixture('an artifact receipt keeps the first attachment and the result message is recorded', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const record = (attachmentId: string) => fixture.prisma.$transaction((tx) => recordDeepWaterArtifactFile(tx, {
    organizationId: fixture.ids.organization, runId: run.id, kind: 'report', attachmentId,
  }))
  const first = await attachment(fixture)
  const second = await attachment(fixture)
  assert.deepEqual(await record(first), { attachmentId: first, stored: true })
  assert.deepEqual(await record(second), { attachmentId: first, stored: false })
  assert.equal((await read(fixture, run.id))?.sourcesFileId, null)

  const messageId = randomUUID()
  await fixture.pool.query(
    `INSERT INTO messages (id, thread_id, role, content) VALUES ($1, $2, 'system', 'Result')`,
    [messageId, fixture.ids.thread],
  )
  await fixture.prisma.$transaction((tx) => recordDeepWaterDeliveryMessage(tx, {
    organizationId: fixture.ids.organization, runId: run.id, resultMessageId: messageId,
  }))
  assert.equal((await read(fixture, run.id))?.resultMessageId, messageId)
})

withFixture('the captured identity is renewed only by the same person, never to an older epoch', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const refresh = (overrides: Partial<typeof fixture.identity>) =>
    fixture.prisma.$transaction((tx) => refreshDeepWaterRunIdentity(tx, {
      organizationId: fixture.ids.organization,
      runId: run.id,
      identity: { ...fixture.identity, ...overrides },
    }))
  assert.deepEqual(await refresh({ tokenVersion: 2 }), { refreshed: false, unblocked: false })
  assert.deepEqual(await refresh({ teamId: 'another-team', tokenVersion: 9 }), { refreshed: false, unblocked: false })
  assert.deepEqual(await refresh({ subject: 'uoa|someone-else', tokenVersion: 9 }), { refreshed: false, unblocked: false })

  await fixture.prisma.$transaction((tx) => blockDeepWaterDelivery(tx, {
    organizationId: fixture.ids.organization, runId: run.id, reason: 'requester_identity_changed',
  }))
  assert.deepEqual(await refresh({ tokenVersion: 4 }), { refreshed: true, unblocked: true })
  const stored = await read(fixture, run.id)
  assert.equal(stored?.uoaIdentity?.tokenVersion, 4)
  assert.equal(stored?.deliveryBlockedReason, null)
  assert.deepEqual(await refresh({ tokenVersion: 4 }), { refreshed: true, unblocked: false })

  assert.equal(mayRefreshDeepWaterIdentity(fixture.identity, { ...fixture.identity, tokenVersion: 3 }), true)
  assert.equal(mayRefreshDeepWaterIdentity(fixture.identity, { ...fixture.identity, organizationId: 'x' }), false)
})

withFixture('one person action is in flight at a time, enqueued with it; a cancel never waits', async (fixture) => {
  const { run } = await insertBrief(fixture, personOrigin())
  const actor = { userId: fixture.ids.requester, role: 'requester' as const, identity: fixture.identity }
  const begin = (actionId: string, action: { kind: 'reply'; message: string } | { kind: 'cancel' }) =>
    fixture.prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, {
      job: { organizationId: fixture.ids.organization, runId: run.id, actionId, actor, action },
    }))

  // The opening scope_start is still in flight.
  const openingActionId = (await read(fixture, run.id))?.scopeState?.pendingAction?.actionId
  assert.ok(openingActionId)
  const reply = randomUUID()
  assert.equal((await begin(reply, { kind: 'reply', message: 'Focus on the UK' })).kind, 'busy')

  const settle = (actionId: string, errorCode: 'busy' | null) =>
    fixture.prisma.$transaction((tx) => settleDeepWaterPersonAction(tx, {
      organizationId: fixture.ids.organization, runId: run.id, actionId, errorCode,
    }))
  assert.equal(await settle(openingActionId, null), true)
  assert.equal(await settle(openingActionId, null), false, 'a late settle finds nothing')

  assert.equal((await begin(reply, { kind: 'reply', message: 'Focus on the UK' })).kind, 'started')
  assert.equal((await begin(reply, { kind: 'reply', message: 'Focus on the UK' })).kind, 'replay')
  const jobs = await fixture.pool.query(
    `SELECT topic, payload FROM queue_jobs WHERE idempotency_key = $1`,
    [`deep-water-brief-action:${run.id}:${reply}`],
  )
  assert.equal(jobs.rows.length, 1)
  assert.equal(jobs.rows[0].topic, 'deep_water.brief.action')

  const cancel = randomUUID()
  assert.equal((await begin(cancel, { kind: 'cancel' })).kind, 'started')
  assert.equal(await settle(reply, 'busy'), false, 'the replaced reply cannot overwrite the cancel')
  assert.equal((await read(fixture, run.id))?.scopeState?.pendingAction?.actionId, cancel)
})

withFixture('an action id is carried out once: a replay after it settled re-arms nothing', async (fixture) => {
  const { run } = await insertBrief(fixture, personOrigin())
  const actor = { userId: fixture.ids.requester, role: 'requester' as const, identity: fixture.identity }
  const begin = (actionId: string, action: { kind: 'reply'; message: string } | { kind: 'cancel' }) =>
    fixture.prisma.$transaction((tx) => beginDeepWaterPersonAction(tx, {
      job: { organizationId: fixture.ids.organization, runId: run.id, actionId, actor, action },
    }))
  const settle = (actionId: string, errorCode: 'rejected' | null) =>
    fixture.prisma.$transaction((tx) => settleDeepWaterPersonAction(tx, {
      organizationId: fixture.ids.organization, runId: run.id, actionId, errorCode,
    }))
  const jobCount = async (actionId: string) => Number((await fixture.pool.query(
    `SELECT count(*)::int AS n FROM queue_jobs WHERE idempotency_key = $1`,
    [`deep-water-brief-action:${run.id}:${actionId}`],
  )).rows[0].n)

  // The opening action is still unacknowledged: there is nothing to cancel yet.
  const opening = (await read(fixture, run.id))?.scopeState?.pendingAction?.actionId
  assert.ok(opening)
  assert.equal((await begin(randomUUID(), { kind: 'cancel' })).kind, 'busy')
  assert.equal(await settle(opening, null), true)

  // A reply that succeeded (cleared), replayed.
  const done = randomUUID()
  assert.equal((await begin(done, { kind: 'reply', message: 'Focus on the UK' })).kind, 'started')
  assert.equal(await settle(done, null), true)
  assert.equal((await begin(done, { kind: 'reply', message: 'Focus on the UK' })).kind, 'replay')
  assert.equal((await read(fixture, run.id))?.scopeState?.pendingAction, null, 'nothing is re-armed')
  assert.equal(await jobCount(done), 1)

  // A reply that failed synchronously (kept with its error), replayed.
  const failed = randomUUID()
  assert.equal((await begin(failed, { kind: 'reply', message: 'And Ireland' })).kind, 'started')
  assert.equal(await settle(failed, 'rejected'), true)
  assert.equal((await begin(failed, { kind: 'reply', message: 'And Ireland' })).kind, 'replay')
  const kept = (await read(fixture, run.id))?.scopeState?.pendingAction
  assert.deepEqual({ id: kept?.actionId, code: kept?.error?.code }, { id: failed, code: 'rejected' })
  assert.equal(await jobCount(failed), 1)
})

withFixture('only an unstarted brief is failed without a research, and the origin destination loads live', async (fixture) => {
  const { run } = await insertBrief(fixture)
  const fail = () => fixture.prisma.$transaction((tx) => failUnstartedDeepWaterBrief(tx, {
    organizationId: fixture.ids.organization, runId: run.id, failureCode: 'scope_rejected',
  }))
  assert.equal(await fail(), true)
  assert.equal(await fail(), false)
  assert.equal((await read(fixture, run.id))?.failureCode, 'scope_rejected')

  await fixture.pool.query(
    `INSERT INTO agent_bindings (id, agent_id, channel_id) VALUES ($1, $2, $3)`,
    [randomUUID(), fixture.ids.agent, fixture.ids.channel],
  )
  assert.deepEqual(
    await loadDeepWaterOriginDestination(fixture.prisma, {
      organizationId: fixture.ids.organization, threadId: fixture.ids.thread,
    }),
    {
      chain: {
        organizationId: fixture.ids.organization,
        projectId: fixture.ids.project,
        teamId: fixture.ids.team,
        channelId: fixture.ids.channel,
      },
      boundAgentIds: [fixture.ids.agent],
    },
  )
  assert.equal(
    await loadDeepWaterOriginDestination(fixture.prisma, {
      organizationId: randomUUID(), threadId: fixture.ids.thread,
    }),
    null,
  )
})
