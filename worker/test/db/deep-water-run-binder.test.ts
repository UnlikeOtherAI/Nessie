import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { ResearchRunRefMessageMetadataSchema } from '@nessie/schemas'

import { createDeepWaterRunBinder } from '../../src/run/deepwater-run-binder.js'
import { withBinderFixture } from './deep-water-run-binder-fixture.js'
import { researchId, wireScope } from './deep-water-watch-fixture.js'

/**
 * An agent's DeepWater calls, bound to their product runs (Water plan
 * nessie.md §7.4, amendments N1, N2, N6, N8.2, amendments-fable F4, F8): the
 * run is claimed before `research_scope_start` leaves, carrying the calling
 * run's sources; the answer attaches the research and posts the agent's card;
 * a start that never came back tells the agent not to start again; and a call
 * naming a research must act for the person who asked for it.
 */

const scopeArgs = { topic: 'Heat pumps in older houses', settings: { depth: 'light', output_language: 'cs' } }

const agentRuns = (fixture: { prisma: PrismaClient; ids: { organization: string } }) =>
  fixture.prisma.productIntegrationRun.findMany({
    where: { organizationId: fixture.ids.organization, productSlug: 'deep-water', originKind: 'agent' },
  })

withBinderFixture('a scope start claims its run before the call leaves, then attaches the research', async (fixture) => {
  fixture.sink.add({ scopeType: 'project', scopeId: fixture.ids.project })
  const rs = researchId()
  const turnId = randomUUID()
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: turnId, seq: 1, status: 'pending', author_kind: 'agent' } }))
  fixture.onSend(async () => {
    const [claimed] = await agentRuns(fixture)
    assert.ok(claimed, 'the run exists while the call is at Ledger')
    assert.equal(claimed.status, 'queued')
    assert.equal(claimed.originAgentId, fixture.ids.agent)
    assert.equal(claimed.originRunId, fixture.ids.originRun)
    assert.equal(claimed.originToolCallId, 'call_start_1')
    assert.equal(claimed.requestedByUserId, fixture.ids.requester)
    assert.deepEqual(claimed.sourceScopes, [{ scopeType: 'project', scopeId: fixture.ids.project }])
  })

  const bound = await fixture.binder.dispatch('research_scope_start', 'call_start_1', scopeArgs, fixture.send)

  assert.equal(fixture.sent[0]?.toolCallId, 'call_start_1')
  assert.deepEqual(fixture.sent[0]?.args, scopeArgs, 'the agent\'s own arguments reach Ledger unchanged')
  assert.match(bound.result.output, /working on this brief/)
  assert.match(bound.result.output, new RegExp(rs))
  const [run] = await agentRuns(fixture)
  assert.ok(run)
  assert.equal(run.status, 'drafting')
  assert.equal(run.externalRunId, rs)
  const stored = await fixture.read(run.id)
  assert.deepEqual(stored.input?.settings, { depth: 'light', outputLanguage: 'cs' })
  assert.deepEqual(stored.scopeState?.turnAuthors[turnId], { kind: 'agent', agentId: fixture.ids.agent })
  const card = await fixture.prisma.message.findUniqueOrThrow({ where: { id: stored.cardMessageId ?? '' } })
  assert.equal(card.agentId, fixture.ids.agent)
  assert.equal(card.role, 'assistant')
  assert.ok(ResearchRunRefMessageMetadataSchema.safeParse(card.metadata).success)
})

withBinderFixture('an agent without the grant opens nothing, and nothing reaches Ledger', async (fixture) => {
  await fixture.prisma.agent.update({ where: { id: fixture.ids.agent }, data: { toolPolicy: {} } })
  const bound = await fixture.binder.dispatch('research_scope_start', 'call_denied', scopeArgs, fixture.send)
  assert.equal(bound.result.success, false)
  assert.equal(bound.transportInvoked, false)
  assert.match(bound.result.output, /^DEEP_WATER_AGENT_GRANT_MISSING/)
  assert.equal(fixture.sent.length, 0)
  assert.equal((await agentRuns(fixture)).length, 0)
})

withBinderFixture('a start that never came back leaves its run for the watch and says not to start again', async (fixture) => {
  fixture.answer(new Error('socket hang up'))
  const thrown = await fixture.binder.dispatch('research_scope_start', 'call_lost', scopeArgs, fixture.send)
  assert.equal(thrown.result.success, false)
  assert.match(thrown.result.output, /may have started/)
  assert.match(thrown.result.output, /Do not call mcp_research_scope_start again/)
  const [kept] = await agentRuns(fixture)
  assert.equal(kept?.status, 'queued')

  fixture.answer({ error: 'upstream_unavailable', status_code: 503 }, false)
  const transient = await fixture.binder.dispatch('research_scope_start', 'call_lost', scopeArgs, fixture.send)
  assert.match(transient.result.output, /may have started/)
  assert.equal((await agentRuns(fixture)).length, 1, 'a retry of the same call finds the same run')
})

withBinderFixture('a start Ledger refuses fails its run', async (fixture) => {
  fixture.answer({ error: 'scope_limit', status_code: 409 }, false)
  const bound = await fixture.binder.dispatch('research_scope_start', 'call_refused', scopeArgs, fixture.send)
  assert.equal(bound.result.success, false)
  const [run] = await agentRuns(fixture)
  assert.equal(run?.status, 'failed')
  assert.equal(run?.failureCode, 'scope_limit')
})

withBinderFixture('a reply acts for the research\'s own requester and adds this run\'s sources', async (fixture) => {
  const rs = researchId()
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'agent' } }))
  await fixture.binder.dispatch('research_scope_start', 'call_open', scopeArgs, fixture.send)
  const [run] = await agentRuns(fixture)
  assert.ok(run)

  const stranger = await fixture.prisma.user.create({ data: { displayName: 'Other', email: `other-${rs}@example.test` } })
  const refused = await fixture.binderFor(stranger.id)
    .dispatch('research_scope_reply', 'call_other', { id: rs, message: 'Mine now.' }, fixture.send)
  assert.equal(refused.transportInvoked, false)
  assert.match(refused.result.output, /^DEEP_WATER_RESEARCH_NOT_FOUND/)
  await fixture.prisma.user.delete({ where: { id: stranger.id } })

  fixture.sink.add({ scopeType: 'user', scopeId: fixture.ids.requester })
  const turnId = randomUUID()
  fixture.answer(wireScope({ id: rs, revision: 1, turn: { id: turnId, seq: 2, status: 'pending', author_kind: 'agent' } }))
  const reply = await fixture.binder.dispatch('research_scope_reply', 'call_reply', { id: rs, message: 'Focus on the UK.' }, fixture.send)
  assert.match(reply.result.output, /working on this brief/)
  const stored = await fixture.read(run.id)
  assert.deepEqual(stored.scopeState?.turnAuthors[turnId], { kind: 'agent', agentId: fixture.ids.agent })
  assert.ok(stored.sourceScopes.some((scope) => scope.scopeType === 'user' && scope.scopeId === fixture.ids.requester))
})

withBinderFixture('reading a research needs its requester to still reach what it was built from', async (fixture) => {
  const rs = researchId()
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'agent' } }))
  await fixture.binder.dispatch('research_scope_start', 'call_open', scopeArgs, fixture.send)
  const [run] = await agentRuns(fixture)
  assert.ok(run)
  const hidden = await fixture.prisma.channel.create({
    data: {
      label: 'hidden', slug: `hidden-${rs}`, visibility: 'private',
      organizationId: fixture.ids.organization, projectId: fixture.ids.project, teamId: fixture.ids.team,
    },
  })
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { sourceScopes: [{ scopeType: 'channel', scopeId: hidden.id }] },
  })
  const sent = fixture.sent.length
  const refused = await fixture.binder.dispatch('research_report', 'call_report', { id: rs }, fixture.send)
  assert.match(refused.result.output, /^DEEP_WATER_SOURCE_ACCESS/)
  assert.equal(fixture.sent.length, sent, 'nothing is read that the requester could not see')

  await fixture.prisma.channelMember.create({ data: { channelId: hidden.id, userId: fixture.ids.requester } })
  fixture.answer({ id: rs, status: 'drafting', title: null, error_code: null })
  await fixture.binder.dispatch('research_status', 'call_status', { id: rs }, fixture.send)
  assert.ok(fixture.sink.list().some((scope) => scope.scopeType === 'channel' && scope.scopeId === hidden.id))
})

withBinderFixture('an agent never publishes, and a research this team never opened cannot be changed', async (fixture) => {
  const rs = researchId()
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'agent' } }))
  await fixture.binder.dispatch('research_scope_start', 'call_open', scopeArgs, fixture.send)
  const sent = fixture.sent.length
  const publish = await fixture.binder.dispatch('research_scope_launch', 'call_publish', { id: rs, revision: 0, public: true }, fixture.send)
  assert.match(publish.result.output, /^DEEP_WATER_PUBLISH_REQUIRES_PERSON/)
  const foreign = await fixture.binder.dispatch('research_cancel', 'call_foreign', { id: researchId() }, fixture.send)
  assert.match(foreign.result.output, /^DEEP_WATER_RESEARCH_NOT_FOUND/)
  assert.equal(fixture.sent.length, sent)

  // Reading one is Ledger's to answer, and feeds only the person's own scope.
  fixture.answer({ id: 'rs_elsewhere', status: 'running', title: null, error_code: null })
  await fixture.binder.dispatch('research_status', 'call_elsewhere', { id: 'rs_elsewhere' }, fixture.send)
  assert.ok(fixture.sink.list().some((scope) => scope.scopeType === 'user' && scope.scopeId === fixture.ids.requester))
})

withBinderFixture('a launch moves the agent\'s brief to running and renews the requester\'s sign-in', async (fixture) => {
  const rs = researchId()
  fixture.answer(wireScope({ id: rs, revision: 1, turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'agent' } }))
  await fixture.binder.dispatch('research_scope_start', 'call_open', scopeArgs, fixture.send)
  const [run] = await agentRuns(fixture)
  assert.ok(run)
  const renewed = { ...fixture.identity, tokenVersion: fixture.identity.tokenVersion + 1 }
  const binder = createDeepWaterRunBinder({ ...fixture.context, uoaIdentity: renewed, requesterIdentity: renewed })
  fixture.answer({ id: rs, job_id: rs, status: 'running' })
  await binder.dispatch('research_scope_launch', 'call_launch', { id: rs, revision: 1 }, fixture.send)
  const stored = await fixture.read(run.id)
  assert.equal(stored.status, 'running')
  assert.deepEqual(stored.uoaIdentity, renewed)
})
