import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { AuthorizedActionContext } from '@nessie/schemas'

import type { ConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { admitTriggerMessageLineage } from '../../src/run/execute/private-conversation-lineage.js'
import { buildResearchRoutingBlock } from '../../src/run/execute/research-routing.js'
import { authorizeToolExecution } from '../../src/run/execute/tool-authorization.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { withBinderFixture, type BinderFixture } from './deep-water-run-binder-fixture.js'
import { researchId, wireScope } from './deep-water-watch-fixture.js'

/**
 * The shared-agent private boundary around DeepWater (Water plan amendments
 * N6, N7): a shared agent can use DeepWater only in a run with no
 * private-conversation lineage. A DM with it, or a private channel, closes
 * every DeepWater tool before the binder claims anything, and the routing
 * prompt sends the person to the Research button instead; a run that read a
 * research built from a private conversation inherits that lineage, so its
 * next DeepWater call is refused the same way. The Personal Assistant is
 * unaffected.
 */

const scopeArgs = { topic: 'Heat pumps in older houses', settings: { depth: 'light' } }

/** A room in the fixture's team with one message from the requester, as a run's trigger. */
const roomWithTrigger = async (fixture: BinderFixture, kind: 'dm' | 'private_channel') => {
  const channel = await fixture.prisma.channel.create({
    data: {
      label: kind,
      slug: `${kind}-${randomUUID()}`,
      organizationId: fixture.ids.organization,
      projectId: fixture.ids.project,
      teamId: fixture.ids.team,
      visibility: 'private',
      ...(kind === 'dm' ? { type: 'dm' as const, dmKey: `${fixture.ids.organization}:dw:${randomUUID()}` } : {}),
    },
  })
  const thread = await fixture.prisma.thread.create({ data: { channelId: channel.id } })
  const message = await fixture.prisma.message.create({
    data: { threadId: thread.id, userId: fixture.ids.requester, role: 'user', content: 'Can you research heat pumps?' },
  })
  return { channel, thread, message }
}

/** Admit a trigger's lineage the way run setup does, before its words become the prompt. */
const admitTrigger = async (fixture: BinderFixture, sink: ConsumedSourceSink, messageId: string) => {
  const message = await fixture.prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: { thread: { include: { channel: { select: { id: true, visibility: true } } } } },
  })
  await admitTriggerMessageLineage(fixture.prisma, sink, { ...message, basisScopes: [], disclosureSources: [] })
}

/** The one pre-dispatch gate every tool call passes, for this fixture's agent. */
const authorize = (
  fixture: BinderFixture,
  input: { agentKind: 'shared' | 'personal_assistant'; channelId: string; threadId: string; toolName: string },
) => {
  const context = {
    agent: { agentKind: input.agentKind, id: fixture.ids.agent, parentAgentId: null },
    boundAgentIds: [],
    consumedSources: fixture.sink,
    channel: { id: input.channelId, organizationId: fixture.ids.organization, projectId: fixture.ids.project, teamId: fixture.ids.team },
    run: { id: fixture.ids.originRun, threadId: input.threadId },
    task: { id: randomUUID() },
  } as unknown as RunContext
  const actorContext = {
    actor: { actorId: fixture.ids.agent, actorType: 'agent', roles: [] },
    actionContext: { requestId: 'deep-water-private-boundary', effectiveUserId: fixture.ids.requester },
    tenant: { organizationId: fixture.ids.organization, projectId: fixture.ids.project, teamId: fixture.ids.team },
  } as unknown as AuthorizedActionContext
  return authorizeToolExecution(fixture.prisma, actorContext, context, input.toolName, scopeArgs, 'call_private', {
    agentKind: input.agentKind,
    allowedToolIds: new Set([input.toolName]),
    unregisteredToolNames: new Set([input.toolName]),
    externalContentToolNames: new Set([input.toolName]),
    maySuspendForApproval: false,
    parentAgentId: null,
    toolPolicy: null,
  }, {
    deepWaterHandoffGuard: { suppressBuiltin: async () => false } as never,
    emitAudit: async () => undefined,
  })
}

const deniedFor = (decision: Awaited<ReturnType<typeof authorize>>): string | null =>
  decision.decision === 'deny'
    ? (JSON.parse(decision.result.output) as { reason: string }).reason
    : null

const agentRuns = (fixture: BinderFixture) =>
  fixture.prisma.productIntegrationRun.count({ where: { organizationId: fixture.ids.organization, originKind: 'agent' } })

for (const kind of ['dm', 'private_channel'] as const) {
  withBinderFixture(`a shared agent in a ${kind.replace('_', ' ')} opens no brief and points at the Research button`, async (fixture) => {
    const { channel, thread, message } = await roomWithTrigger(fixture, kind)
    await admitTrigger(fixture, fixture.sink, message.id)

    for (const toolName of ['mcp_research_scope_start', 'mcp_research_scope_get', 'mcp_research_list']) {
      const decision = await authorize(fixture, { agentKind: 'shared', channelId: channel.id, threadId: thread.id, toolName })
      assert.equal(deniedFor(decision), 'private_conversation_disclosure_required', toolName)
    }
    // The gate decides before the toolset dispatches, so the binder claimed nothing and Ledger heard nothing.
    assert.equal(await agentRuns(fixture), 0)
    assert.equal(fixture.sent.length, 0)

    const routing = buildResearchRoutingBlock({
      hasDelegate: false,
      researchTools: new Set(['research_scope_start', 'research_scope_get', 'research_scope_reply']),
      hasCardPost: true,
      hasWebSearch: true,
      isHandoffTurn: false,
    })
    assert.match(routing ?? '', /refused because this conversation is private, do not retry/)
    assert.match(routing ?? '', /start the research themselves with the Research button in this chat/)
  })
}

withBinderFixture('the Personal Assistant in its own DM may open a brief', async (fixture) => {
  const { channel, thread, message } = await roomWithTrigger(fixture, 'dm')
  await admitTrigger(fixture, fixture.sink, message.id)
  const decision = await authorize(fixture, {
    agentKind: 'personal_assistant', channelId: channel.id, threadId: thread.id, toolName: 'mcp_research_scope_start',
  })
  assert.notEqual(deniedFor(decision), 'private_conversation_disclosure_required')
})

withBinderFixture('a shared agent that read a research built from a private conversation is refused its next call', async (fixture) => {
  // The agent's research in the public room, whose brief a person had built from their private room.
  const rs = researchId()
  fixture.answer(wireScope({ id: rs, revision: 0, turn: { id: randomUUID(), seq: 1, status: 'complete', author_kind: 'agent' } }))
  await fixture.binder.dispatch('research_scope_start', 'call_public', scopeArgs, fixture.send)
  const run = await fixture.prisma.productIntegrationRun.findFirstOrThrow({
    where: { organizationId: fixture.ids.organization, originKind: 'agent' },
  })
  const { channel } = await roomWithTrigger(fixture, 'private_channel')
  const lineage = { sourceChannelId: channel.id, sourceAuthorUserId: fixture.ids.requester }
  await fixture.prisma.productIntegrationRun.update({
    where: { id: run.id },
    data: { disclosureSources: [lineage], sourceScopes: [{ scopeType: 'channel', scopeId: channel.id }] },
  })
  // The requester is in that room, so they may still read it; the member check is not what refuses.
  await fixture.prisma.channelMember.create({ data: { channelId: channel.id, userId: fixture.ids.requester } })

  const publicCall = { agentKind: 'shared' as const, channelId: fixture.ids.channel, threadId: fixture.ids.thread }
  assert.equal(deniedFor(await authorize(fixture, { ...publicCall, toolName: 'mcp_research_report' })), null)
  fixture.answer({ id: rs, status: 'complete', title: 'Heat pumps', markdown: '# Heat pumps', sources: [] })
  const read = await fixture.binder.dispatch('research_report', 'call_report', { id: rs }, fixture.send)
  assert.equal(read.result.success, true)
  assert.deepEqual(fixture.sink.privateConversationSources(), [lineage], 'the report\'s lineage is now the run\'s')

  const next = await authorize(fixture, { ...publicCall, toolName: 'mcp_research_status' })
  assert.equal(deniedFor(next), 'private_conversation_disclosure_required')
})
