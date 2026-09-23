import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { AuthorizedActionContext } from '@nessie/schemas'

import { resolveDeepWaterResearchReadiness } from '../src/services/deepwater-research-readiness.js'
import { RUNS, drafted, open, withBriefApi } from './deepwater-research-runs-fixture.js'

/**
 * The DeepWater brief API (Water plan nessie.md §7.1, contract D10,
 * amendments N6, N8.5, amendments-fable F3, F8): a person's action is recorded
 * and enqueued once per actionId, a brief is theirs alone until it launches,
 * edits are judged against the brief as Nessie last saw it, Start counts the
 * pillars it carries, and an owner cancels any open research with their own
 * identity.
 */

withBriefApi('opening a brief records its opening action once, and a replay answers the same brief', async (fixture) => {
  const { actionId, response, runId } = await open(fixture)
  assert.equal(response.statusCode, 202)
  assert.equal(response.body.data?.status, 'drafting')
  const plannerTurn = response.body.data?.plannerTurn as { status: string; actionId: string }
  assert.equal(plannerTurn.status, 'replying')
  assert.equal(plannerTurn.actionId, actionId)
  const jobs = await fixture.briefJobs(runId)
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0]?.payload.actor, { userId: fixture.ids.requester, role: 'requester', identity: fixture.identity })
  assert.ok(fixture.published.some((event) => event.event === 'integration.run.updated'))

  const replay = await fixture.request('POST', RUNS, {
    actionId,
    origin: { kind: 'thread', channelId: fixture.ids.channel, threadId: fixture.ids.thread },
    topic: 'Heat pumps in older houses',
  })
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.body.data?.id, runId)
  assert.equal((await fixture.briefJobs(runId)).length, 1)
})

withBriefApi('opening a brief is refused before anything is written when DeepWater cannot act', async (fixture) => {
  const secret = await open(fixture, { topic: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH please' })
  assert.equal(secret.response.statusCode, 422)
  assert.equal(secret.response.body.error?.code, 'SECRET_INTERCEPTED')

  fixture.actAs('colleague') // signed in without a DeepWater link
  const unlinked = await open(fixture)
  assert.equal(unlinked.response.statusCode, 409)
  assert.deepEqual(unlinked.response.body.error?.details, { reason: 'account_not_linked' })

  fixture.actAs('requester')
  await fixture.prisma.productTeamEnablement.updateMany({
    where: { organizationId: fixture.ids.organization },
    data: { enabled: false },
  })
  const off = await open(fixture)
  assert.equal(off.response.statusCode, 409)
  assert.equal(off.response.body.error?.code, 'DEEP_WATER_NOT_READY')
  assert.deepEqual(off.response.body.error?.details, { reason: 'team_off' })
  assert.equal(await fixture.prisma.productIntegrationRun.count({ where: { organizationId: fixture.ids.organization } }), 0)
})

withBriefApi('a person\'s brief is theirs alone until it launches', async (fixture) => {
  const { runId } = await open(fixture)
  const mine = await fixture.request('GET', RUNS)
  assert.deepEqual((mine.body.data?.items as Array<{ id: string }>).map((item) => item.id), [runId])

  fixture.actAs('colleague')
  assert.deepEqual((await fixture.request('GET', RUNS)).body.data?.items, [])
  assert.equal((await fixture.request('GET', `${RUNS}/${runId}`)).statusCode, 404)
  assert.equal((await fixture.request('GET', `${RUNS}/${runId}/brief`)).statusCode, 404)

  await fixture.prisma.productIntegrationRun.update({ where: { id: runId }, data: { status: 'running' } })
  const launched = await fixture.request('GET', `${RUNS}/${runId}`)
  assert.equal(launched.statusCode, 200)
  assert.equal(launched.body.data?.status, 'running')
  assert.deepEqual(launched.body.data?.viewer, { canEdit: false, canStart: false, canCancel: false, canRetryDelivery: false })
})

withBriefApi('a reply is judged against the brief Nessie last saw, one action at a time', async (fixture) => {
  const { runId } = await open(fixture)
  const early = await fixture.request('POST', `${RUNS}/${runId}/messages`, { actionId: randomUUID(), message: 'Hello' })
  assert.equal(early.statusCode, 409, 'a brief still opening cannot take a reply')
  await drafted(fixture, runId)

  const stale = await fixture.request('POST', `${RUNS}/${runId}/messages`, {
    actionId: randomUUID(), message: 'Hello', baseRevision: 0, pillars: ['Costs', 'Noise'],
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.body.error?.code, 'DEEP_WATER_BRIEF_REVISION_CONFLICT')
  assert.deepEqual(stale.body.error?.details, { currentRevision: 1 })

  const replyId = randomUUID()
  const reply = await fixture.request('POST', `${RUNS}/${runId}/messages`, {
    actionId: replyId, message: 'Focus on the UK', baseRevision: 1, settings: { outputLanguage: 'cs' },
  })
  assert.equal(reply.statusCode, 202)
  const job = (await fixture.briefJobs(runId)).find((row) => row.payload.actionId === replyId)
  assert.deepEqual(job?.payload.action, {
    kind: 'reply', message: 'Focus on the UK', baseRevision: 1, settings: { outputLanguage: 'cs' },
  })

  const busy = await fixture.request('POST', `${RUNS}/${runId}/messages`, { actionId: randomUUID(), message: 'And?' })
  assert.equal(busy.body.error?.code, 'DEEP_WATER_BRIEF_BUSY')
  const replayed = await fixture.request('POST', `${RUNS}/${runId}/messages`, { actionId: replyId, message: 'Focus on the UK' })
  assert.equal(replayed.statusCode, 200, 'a lost response retried with its actionId is a replay, not busy')

  fixture.actAs('colleague')
  const notTheirs = await fixture.request('POST', `${RUNS}/${runId}/messages`, { actionId: randomUUID(), message: 'Mine' })
  assert.equal(notTheirs.statusCode, 404, 'a brief the colleague cannot see does not exist for them')
})

withBriefApi('Start needs a pillar, from the brief or from the request itself', async (fixture) => {
  const { runId } = await open(fixture)
  await drafted(fixture, runId, [])
  const empty = await fixture.request('POST', `${RUNS}/${runId}/start`, { actionId: randomUUID(), revision: 1 })
  assert.equal(empty.statusCode, 422)
  assert.equal(empty.body.error?.code, 'DEEP_WATER_BRIEF_INCOMPLETE')

  const startId = randomUUID()
  const started = await fixture.request('POST', `${RUNS}/${runId}/start`, {
    actionId: startId, revision: 1, pillars: ['Written by hand'], public: true,
  })
  assert.equal(started.statusCode, 202)
  assert.equal(started.body.data?.status, 'starting')
  const job = (await fixture.briefJobs(runId)).find((row) => row.payload.actionId === startId)
  assert.deepEqual(job?.payload.action, { kind: 'launch', revision: 1, pillars: ['Written by hand'], public: true })
})

withBriefApi('an owner cancels someone else\'s research with their own identity, seeing only its id', async (fixture) => {
  const { runId } = await open(fixture)
  const opening = await fixture.request('POST', `${RUNS}/${runId}/cancel`, { actionId: randomUUID() })
  assert.equal(opening.body.error?.code, 'DEEP_WATER_BRIEF_BUSY', 'nothing to cancel until Ledger names the research')
  await drafted(fixture, runId)

  fixture.actAs('colleague')
  assert.equal((await fixture.request('POST', `${RUNS}/${runId}/cancel`, { actionId: randomUUID() })).statusCode, 404)

  fixture.actAs('owner')
  const ownerIdentity = {
    subject: `uoa|${fixture.ids.owner}`, organizationId: fixture.identity.organizationId,
    teamId: fixture.identity.teamId, tokenVersion: 5,
  }
  await fixture.prisma.productAccountLink.create({
    data: {
      organizationId: fixture.ids.organization, userId: fixture.ids.owner, productSlug: 'deep-water',
      uoaSub: ownerIdentity.subject, uoaTokenVersion: 5, status: 'linked',
    },
  })
  const noSession = await fixture.request('POST', `${RUNS}/${runId}/cancel`, { actionId: randomUUID() })
  assert.deepEqual(noSession.body.error?.details, { reason: 'account_not_linked' }, 'DeepWater is asked as the owner')

  fixture.signIn('owner', ownerIdentity)
  const cancelId = randomUUID()
  const cancel = await fixture.request('POST', `${RUNS}/${runId}/cancel`, { actionId: cancelId })
  assert.equal(cancel.statusCode, 202)
  assert.deepEqual(Object.keys(cancel.body.data ?? {}).sort(), ['id', 'status'], 'the owner cannot read the brief')
  const job = (await fixture.briefJobs(runId)).find((row) => row.payload.actionId === cancelId)
  assert.deepEqual(job?.payload.actor, { userId: fixture.ids.owner, role: 'owner', identity: ownerIdentity })
  // Asked for now; the worker audits what DeepWater did with it.
  const audit = await fixture.prisma.auditLog.findMany({
    where: { organizationId: fixture.ids.organization, action: 'integration.research.cancel_requested' },
  })
  assert.equal(audit.length, 1)
  assert.equal(audit[0]?.resourceId, runId)
  assert.equal(audit[0]?.actorId, fixture.ids.owner)
})

withBriefApi('research readiness names the one remedy for this person and team', async (fixture) => {
  const context = (userId: string, withIdentity: boolean, roles: string[] = ['member']) => ({
    actionContext: { requestId: 'readiness', teamId: fixture.ids.team, ...(withIdentity ? { uoaIdentity: fixture.identity } : {}) },
    actor: { actorId: userId, actorType: 'user', roles },
    tenant: { organizationId: fixture.ids.organization, teamId: fixture.ids.team },
  }) as unknown as AuthorizedActionContext
  const ledgerIdentity = { requestHeaders: async () => ({}) }
  const readiness = (ctx: AuthorizedActionContext, identity: typeof ledgerIdentity | null = ledgerIdentity) =>
    resolveDeepWaterResearchReadiness(fixture.prisma, ctx, { teamId: fixture.ids.team, ledgerIdentity: identity })

  assert.deepEqual(await readiness(context(fixture.ids.requester, true)), { state: 'ready', viewerCanChangeTeam: false })
  assert.equal((await readiness(context(fixture.ids.colleague, false))).state, 'account_not_linked')
  assert.equal((await readiness(context(fixture.ids.requester, true), null)).state, 'unavailable')
  assert.equal((await readiness(context(fixture.ids.owner, false, ['owner']))).viewerCanChangeTeam, true)

  await fixture.prisma.mcpServerInstance.update({
    where: { id: fixture.ids.connector },
    data: { discoveredTools: [{ name: 'research_start' }, { name: 'research_status' }] },
  })
  assert.equal((await readiness(context(fixture.ids.requester, true))).state, 'contract_outdated')
  await fixture.prisma.productTeamEnablement.updateMany({
    where: { organizationId: fixture.ids.organization },
    data: { enabled: false },
  })
  assert.equal((await readiness(context(fixture.ids.requester, true))).state, 'team_off')
})
