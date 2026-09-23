import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { DeepWaterActiveRunRevocationError, guardDeepWaterPolicyRevocation } from '@nessie/mcp-manage'
import { LedgerIdentityError, UOA_SUBJECT_FORBIDDEN_CODE, type UoaExchangeFailure } from '@nessie/runtime'
import { DeepWaterNoticeMessageMetadataSchema, PushDispatchJobPayloadSchema } from '@nessie/schemas'

import { watchDeepWaterRun } from '../../src/control/deepwater-watch.js'
import { reapUnconfirmedDeepWaterBriefs, retryDeepWaterDelivery } from '../../src/control/deepwater-worker.js'
import { launchedBrief, researchId, seedWatchFixture, wireScope, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * What the watch does when UOA will not delegate the requester's captured
 * identity (Water plan amendments-fable F4). UOA refusing the person — a moved
 * sign-in epoch, a lost organisation or team, which its 403 names as
 * `TOKEN_EXCHANGE_SUBJECT_FORBIDDEN` — is identity drift: the run is blocked
 * once with `requester_identity_changed` and they are told, instead of being
 * re-read every 30 s for ever with a fresh exchange each time. Only an outage
 * is read again soon; a deployment fault — including a 403 that does not name
 * the person, because UOA answers 403 for Nessie's own delegation setup too —
 * keeps the claim's backoff and blames nobody. A notice about a changed sign-in
 * is its own kind (`identity_changed`), so a lock screen never calls a research
 * that is still running one waiting to be saved.
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

const exchangeFailed = (failure: UoaExchangeFailure): LedgerIdentityError =>
  new LedgerIdentityError('LEDGER_UOA_TOKEN_EXCHANGE_FAILED', 'UOA delegation exchange failed', failure)

/** A launched research, just claimed: the next read backed off ten minutes. */
const claimedResearch = async (fixture: WatchFixture) => {
  const run = await fixture.insert('person')
  await fixture.attach(run.id, {
    id: researchId(), status: 'running', errorCode: null, title: 'Heat pumps', brief: launchedBrief(),
    turn: { id: randomUUID(), seq: 1, status: 'complete', authorKind: 'person', errorCode: null, retryable: false },
  })
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { reconcileSeq: { increment: 1 }, reconcileAfter: new Date(Date.now() + 10 * 60_000) },
  })
  return fixture.read(run.id)
}

const noticeKinds = async (fixture: WatchFixture, runId: string) =>
  (await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread }, orderBy: { createdAt: 'asc' } }))
    .flatMap((message) => {
      const notice = DeepWaterNoticeMessageMetadataSchema.safeParse(message.metadata)
      return notice.success && notice.data.deepWaterNotice.runId === runId ? [notice.data.deepWaterNotice.kind] : []
    })

const nextReadIn = async (fixture: WatchFixture, runId: string) =>
  (await fixture.read(runId)).reconcileAfter.getTime() - Date.now()

withFixture('UOA refusing the requester blocks the research once and tells them, never a 30 s loop', async (fixture) => {
  const run = await claimedResearch(fixture)
  fixture.failIdentity(exchangeFailed({ kind: 'refused', status: 403, code: UOA_SUBJECT_FORBIDDEN_CODE }))
  await watchDeepWaterRun(fixture.deps, run)
  // A second read, as a person's retry would make before they sign in again.
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))

  const blocked = await fixture.read(run.id)
  assert.equal(blocked.deliveryBlockedReason, 'requester_identity_changed')
  assert.equal(blocked.status, 'running', 'kept open so a retry can deliver it')
  assert.ok(await nextReadIn(fixture, run.id) > 9 * 60_000, 'no fast retry for a refused person')
  assert.deepEqual(await noticeKinds(fixture, run.id), ['identity_changed'])
  assert.equal(fixture.ledger.calls.length, 0, 'nothing reaches Ledger without a delegation')
})

withFixture('a research drawn on a private conversation is never called one waiting to be saved on the lock screen', async (fixture) => {
  const run = await claimedResearch(fixture)
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: {
      sourceScopes: [{ scopeType: 'channel', scopeId: fixture.ids.assistantChannel }],
      disclosureSources: [{ sourceChannelId: fixture.ids.assistantChannel, sourceAuthorUserId: fixture.ids.requester }],
    },
  })
  fixture.failIdentity(exchangeFailed({ kind: 'refused', status: 403, code: UOA_SUBJECT_FORBIDDEN_CODE }))
  await watchDeepWaterRun(fixture.deps, await fixture.read(run.id))

  const [notice] = await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread, role: 'assistant' } })
  const [job] = await fixture.prisma.queueJob.findMany({
    where: { topic: 'push.dispatch', payload: { path: ['messageId'], equals: notice?.id ?? '' } },
  })
  const push = PushDispatchJobPayloadSchema.parse(job?.payload)
  assert.equal(push.contentVisibility, 'generic')
  assert.equal(push.genericBody, 'Sign in again so your DeepWater research can carry on.')
  assert.deepEqual(push.mentionUserIds, [fixture.ids.requester])
})

withFixture('a token for another sign-in epoch is the same drift', async (fixture) => {
  const run = await claimedResearch(fixture)
  fixture.failIdentity(exchangeFailed({ kind: 'epoch_mismatch' }))
  await watchDeepWaterRun(fixture.deps, run)
  assert.equal((await fixture.read(run.id)).deliveryBlockedReason, 'requester_identity_changed')
  assert.deepEqual(await noticeKinds(fixture, run.id), ['identity_changed'])
})

withFixture('a person\'s own brief refused by UOA waits quietly for them to sign in again', async (fixture) => {
  const brief = await fixture.insert('person')
  await fixture.attach(brief.id, {
    id: researchId(), status: 'drafting', errorCode: null, title: null, brief: null,
    turn: { id: randomUUID(), seq: 1, status: 'pending', authorKind: 'person', errorCode: null, retryable: false },
  })
  fixture.failIdentity(exchangeFailed({ kind: 'refused', status: 403, code: UOA_SUBJECT_FORBIDDEN_CODE }))
  await watchDeepWaterRun(fixture.deps, await fixture.read(brief.id))
  const blocked = await fixture.read(brief.id)
  assert.equal(blocked.deliveryBlockedReason, 'requester_identity_changed')
  assert.equal(blocked.status, 'drafting')
  assert.deepEqual(await noticeKinds(fixture, brief.id), [], 'its dialog says "Sign in again"')
})

withFixture('only an outage at UOA is read again within 30 s', async (fixture) => {
  const run = await claimedResearch(fixture)
  fixture.failIdentity(exchangeFailed({ kind: 'refused', status: 503, code: null }))
  await watchDeepWaterRun(fixture.deps, run)
  const soon = await nextReadIn(fixture, run.id)
  assert.ok(soon > 20_000 && soon <= 30_000, `read again within 30 s (${soon} ms)`)
  assert.equal((await fixture.read(run.id)).deliveryBlockedReason, null)
  assert.deepEqual(await noticeKinds(fixture, run.id), [])
})

for (const [label, failure] of [
  ['a refused client', { kind: 'refused', status: 401, code: null }],
  ['a 403 that does not name the person', { kind: 'refused', status: 403, code: null }],
  ['a refused delegation mapping', { kind: 'refused', status: 403, code: 'TOKEN_EXCHANGE_DELEGATION_NOT_ALLOWED' }],
] satisfies Array<[string, UoaExchangeFailure]>) {
  withFixture(`a deployment fault at UOA (${label}) fails the read, keeps the backoff and blames nobody`, async (fixture) => {
    const run = await claimedResearch(fixture)
    fixture.failIdentity(exchangeFailed(failure))
    await assert.rejects(watchDeepWaterRun(fixture.deps, run), LedgerIdentityError)
    const after = await fixture.read(run.id)
    assert.equal(after.deliveryBlockedReason, null, 'the requester did nothing wrong')
    assert.ok(await nextReadIn(fixture, run.id) > 9 * 60_000, 'repeating a fault changes nothing')
    assert.deepEqual(await noticeKinds(fixture, run.id), [])
  })
}

/** An agent's brief whose scope start was lost and whose replay UOA refused: blocked and told once. */
const blockedAgentStart = async (fixture: WatchFixture) => {
  const brief = await fixture.insert('agent')
  fixture.failIdentity(exchangeFailed({ kind: 'refused', status: 403, code: UOA_SUBJECT_FORBIDDEN_CODE }))
  await watchDeepWaterRun(fixture.deps, brief)
  await watchDeepWaterRun(fixture.deps, await fixture.read(brief.id))

  const blocked = await fixture.read(brief.id)
  assert.equal(blocked.deliveryBlockedReason, 'requester_identity_changed')
  assert.equal(blocked.status, 'queued')
  assert.equal(fixture.ledger.calls.length, 0, 'nothing reaches Ledger without a delegation')
  assert.deepEqual(await noticeKinds(fixture, brief.id), ['identity_changed'], 'told once')
  const [notice] = await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread, role: 'assistant' } })
  assert.match(notice?.content ?? '', /agent working on your DeepWater research brief/)
  assert.match(notice?.content ?? '', /Sign in again, then choose Retry/)
  return blocked
}

withFixture('a lost agent scope start UOA refuses to replay is blocked and told, and their Retry replays it', async (fixture) => {
  const brief = await blockedAgentStart(fixture)

  // Inside the confirm window it is still the requester's to renew, not DeepWater's failure.
  await reapUnconfirmedDeepWaterBriefs(fixture.deps)
  const waiting = await fixture.read(brief.id)
  assert.equal(waiting.status, 'queued')
  assert.equal(waiting.failureCode, null)

  // Their Retry renews the identity and replays the call, which attaches it.
  fixture.failIdentity(false)
  const rs = researchId()
  fixture.ledger.answer('research_scope_start', wireScope({
    id: rs, turn: { id: randomUUID(), seq: 1, status: 'pending', author_kind: 'agent' },
  }))
  await retryDeepWaterDelivery(fixture.deps, {
    organizationId: fixture.ids.organization,
    runId: brief.id,
    actionId: randomUUID(),
    identity: { ...fixture.identity, tokenVersion: fixture.identity.tokenVersion + 1 },
  })
  const resumed = await fixture.read(brief.id)
  assert.equal(resumed.deliveryBlockedReason, null)
  assert.equal(resumed.externalRunId, rs)
  assert.equal(resumed.status, 'drafting')
})

/** The open runs the team's DeepWater disable waits for (`removeDeepWaterTeamInstanceInTransaction`). */
const holdsTeamConnector = async (fixture: WatchFixture) =>
  (await fixture.prisma.productIntegrationRun.count({
    where: {
      connectorId: fixture.ids.connector,
      organizationId: fixture.ids.organization,
      productSlug: 'deep-water',
      status: { in: ['queued', 'drafting', 'running', 'needs_setup'] },
      teamId: fixture.ids.team,
    },
  })) > 0

const guardAgentRevocation = (fixture: WatchFixture) => fixture.prisma.$transaction((tx) =>
  guardDeepWaterPolicyRevocation(tx, {
    organizationId: fixture.ids.organization,
    teamId: fixture.ids.team,
    mode: { kind: 'agent', agentId: fixture.ids.agent },
  }))

withFixture('a blocked agent brief nobody renews is closed after the window, told in its own words, and holds nothing open', async (fixture) => {
  const brief = await blockedAgentStart(fixture)
  assert.ok(await holdsTeamConnector(fixture), 'an open brief holds the team connector')
  await assert.rejects(guardAgentRevocation(fixture), DeepWaterActiveRunRevocationError)

  await fixture.prisma.productIntegrationRun.update({
    where: { id: brief.id },
    data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
  })
  await reapUnconfirmedDeepWaterBriefs(fixture.deps)
  await reapUnconfirmedDeepWaterBriefs(fixture.deps)

  const closed = await fixture.read(brief.id)
  assert.equal(closed.status, 'failed')
  assert.equal(closed.failureCode, 'start_identity_changed')
  assert.equal(closed.deliveryBlockedReason, null, 'an ended brief offers no Retry')
  assert.equal(closed.deliveredAt, null, 'a late confirmation can still attach it')
  assert.deepEqual(await noticeKinds(fixture, brief.id), ['identity_changed', 'start_identity_changed'], 'told once more')
  const [, notice] = await fixture.prisma.message.findMany({
    where: { threadId: fixture.ids.thread, role: 'assistant' },
    orderBy: { createdAt: 'asc' },
  })
  assert.match(notice?.content ?? '', /couldn't open it because your sign-in has changed, so it has been closed/)
  assert.doesNotMatch(notice?.content ?? '', /didn't confirm/)
  assert.deepEqual(
    await fixture.prisma.message.findMany({ where: { threadId: fixture.ids.thread, role: 'system' } }),
    [],
    'the agent is not woken to act with a sign-in UOA refused',
  )
  assert.equal(fixture.ledger.calls.length, 0)

  assert.equal(await holdsTeamConnector(fixture), false, 'the team can turn DeepWater off')
  await guardAgentRevocation(fixture)
})
