import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeOrchestrateDecideJob,
  resolveConversationDecisions,
  resolveSystemDmDecisions,
  runActorContextForCandidate,
} from './orchestrate.js'
import type { OrchestrateDecideDeps } from './orchestrate.js'

const personalAssistant = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Personal Assistant',
  role: 'assistant',
  systemPrompt: null,
}

test('a personal-assistant DM always creates a threaded reply decision for a human turn', () => {
  assert.deepEqual(
    resolveSystemDmDecisions('personal_assistant', 'user', [personalAssistant]),
    // Structural, like the @mention fast path: the turn is addressed to this
    // one assistant, so its answer belongs to that exchange.
    [{ action: 'reply', agentId: personalAssistant.id, replyPlacement: 'thread' }],
  )
})

test('a personal-assistant DM does not reply to an assistant-authored turn', () => {
  assert.deepEqual(
    resolveSystemDmDecisions('personal_assistant', 'assistant', [personalAssistant]),
    [],
  )
})

test('shared channels remain on the model-judged engagement path', () => {
  assert.equal(
    resolveSystemDmDecisions(null, 'user', [personalAssistant]),
    null,
  )
})

test('a global agent home DM takes the same structural route', () => {
  const designer = { ...personalAssistant, name: 'Agent Designer' }
  assert.deepEqual(
    resolveSystemDmDecisions('system_agent', 'user', [designer]),
    // Keyed on the channel type alone. A global agent's home DM has exactly one
    // member and exactly one binding, both database facts, so there is no
    // engagement judgement to make — in any language, slang or spelling.
    [{ action: 'reply', agentId: designer.id, replyPlacement: 'thread' }],
  )
  assert.deepEqual(resolveSystemDmDecisions('system_agent', 'assistant', [designer]), [])
})

test('other system channels keep the model-judged engagement path', () => {
  // An external-agent DM is driven by its own proxy path, and a hosted mailbox
  // operations room is an ordinary room with many participants.
  assert.equal(resolveSystemDmDecisions('external_agent', 'user', [personalAssistant]), null)
  assert.equal(resolveSystemDmDecisions('agent_email', 'user', [personalAssistant]), null)
})

test('a shared-channel PA run takes the presence owner as its effective user', () => {
  const principalUserId = '00000000-0000-4000-8000-000000000002'
  const context = runActorContextForCandidate(
    {
      actionContext: { requestId: 'pa-presence' },
      actor: {
        actorId: '00000000-0000-4000-8000-000000000003',
        actorType: 'user',
        roles: ['member'],
      },
      tenant: { organizationId: '00000000-0000-4000-8000-000000000004' },
    } as never,
    { ...personalAssistant, principalUserId } as never,
  )

  assert.equal(context.actor.actorId, '00000000-0000-4000-8000-000000000003')
  assert.equal(context.actionContext.effectiveUserId, principalUserId)
})

/**
 * The conversation branch (docs/plans/2026-09-08-agent-conversations.md §3).
 *
 * Every case below is decided from columns — `Thread.agent_id`, the trigger's
 * `root_message_id`, the message role, the channel's bindings — so the model is
 * never consulted. That is asserted directly: `resolveConversationDecisions`
 * takes no model client, and `executeOrchestrateDecideJob` only reaches
 * `decideAgentEngagement` when this returns `null`.
 */

const researcher = {
  id: '00000000-0000-4000-8000-000000000011',
  name: 'Researcher',
  role: 'assistant',
  systemPrompt: null,
}
const reporter = {
  id: '00000000-0000-4000-8000-000000000012',
  name: 'Reporter',
  role: 'assistant',
  systemPrompt: null,
}
const STARTER_ID = '00000000-0000-4000-8000-000000000013'
const OTHER_MEMBER_ID = '00000000-0000-4000-8000-000000000014'

test('a top-level human turn in a conversation engages that conversation\'s agent', () => {
  assert.deepEqual(
    resolveConversationDecisions({
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    [{ action: 'reply', agentId: researcher.id, replyPlacement: 'thread' }],
  )
})

test('the same message in the room\'s General thread takes the existing path', () => {
  // `agentId: null` is the General thread. Nothing structural addresses anyone,
  // so the model-judged path decides — which is what `null` means here.
  assert.equal(
    resolveConversationDecisions({
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: null, startedByUserId: null },
    }),
    null,
  )
})

test('an assistant-authored turn inside a conversation engages nobody', () => {
  // The anti-loop bound: two agents in one conversation cannot talk each other
  // in a circle, in any language, slang or spelling.
  assert.deepEqual(
    resolveConversationDecisions({
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: true,
      role: 'assistant',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    [],
  )
})

test('an assistant-authored *reply* inside a conversation engages nobody either', () => {
  // The anti-loop bound is about who wrote the turn, not about where it sits.
  // While the top-level check came first, this exact case — an agent's reply
  // inside a conversation — returned `null` and fell through to the
  // model-judged path, which is free to answer it; that is the circle the
  // bound exists to prevent, reached by the one shape that skipped it.
  assert.deepEqual(
    resolveConversationDecisions({
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: false,
      role: 'assistant',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    [],
  )
})

test('an @mention inside a conversation adds the mentioned agent', () => {
  assert.deepEqual(
    resolveConversationDecisions({
      agentMentions: [{ type: 'agent', agentId: reporter.id }] as never,
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    [
      { action: 'reply', agentId: researcher.id, replyPlacement: 'thread' },
      { action: 'reply', agentId: reporter.id, replyPlacement: 'thread' },
    ],
  )
})

test('@mentioning the conversation\'s own agent does not double it', () => {
  assert.deepEqual(
    resolveConversationDecisions({
      agentMentions: [{ type: 'agent', agentId: researcher.id }] as never,
      channelAgents: [researcher, reporter],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    [{ action: 'reply', agentId: researcher.id, replyPlacement: 'thread' }],
  )
})

test('a message inside a reply thread keeps today\'s behaviour', () => {
  assert.equal(
    resolveConversationDecisions({
      channelAgents: [researcher],
      isTopLevelTrigger: false,
      role: 'user',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    null,
  )
})

test('a conversation whose agent was unbound since falls through to the model', () => {
  assert.equal(
    resolveConversationDecisions({
      channelAgents: [reporter],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: researcher.id, startedByUserId: STARTER_ID },
    }),
    null,
  )
})

test('a PA conversation engages the presence of whoever started it', () => {
  const mine = { ...personalAssistant, principalUserId: STARTER_ID }
  const theirs = { ...personalAssistant, principalUserId: OTHER_MEMBER_ID }
  assert.deepEqual(
    resolveConversationDecisions({
      channelAgents: [theirs, mine],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: personalAssistant.id, startedByUserId: STARTER_ID },
    }),
    [
      {
        action: 'reply',
        agentId: personalAssistant.id,
        principalUserId: STARTER_ID,
        replyPlacement: 'thread',
      },
    ],
  )
})

test('a PA conversation started by somebody with no presence here engages nobody structurally', () => {
  const theirs = { ...personalAssistant, principalUserId: OTHER_MEMBER_ID }
  assert.equal(
    resolveConversationDecisions({
      channelAgents: [theirs],
      isTopLevelTrigger: true,
      role: 'user',
      thread: { agentId: personalAssistant.id, startedByUserId: STARTER_ID },
    }),
    null,
  )
})

/**
 * The same rule, end to end through `executeOrchestrateDecideJob` — because the
 * point of a *structural* branch is not only which decision it makes but that it
 * makes it without spending an inference. The pair below is the proof: identical
 * payload, identical fixtures, one difference (whether the trigger's thread
 * carries an `agent_id`), and the mock model is consulted in exactly one of them.
 */

const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000a1'
const CHANNEL_ID = '00000000-0000-4000-8000-0000000000a2'
const THREAD_ID = '00000000-0000-4000-8000-0000000000a3'
const MESSAGE_ID = '00000000-0000-4000-8000-0000000000a4'

const decideFixture = (thread: { agentId: string | null; startedByUserId: string | null }) => {
  const modelCalls: string[] = []
  const transactions: number[] = []
  const deps = {
    modelClient: {
      chat: async () => {
        modelCalls.push('chat')
        return '{"action":"none"}'
      },
    },
    prisma: {
      attachment: { findMany: async () => [] },
      budget: { findMany: async () => [] },
      channel: {
        findUnique: async () => ({
          organizationId: ORGANIZATION_ID,
          systemChannelType: null,
        }),
      },
      message: {
        findMany: async () => [],
        // `role` and `threadId` are read from the row rather than believed
        // from the payload; a fake omitting either would silently take the
        // consistency guard's other branch.
        findUnique: async () => ({
          id: MESSAGE_ID,
          role: 'user',
          rootMessageId: null,
          thread,
          threadId: THREAD_ID,
        }),
      },
      // Reached only on the model-judged path, where the window is
      // disclosure-filtered before the engagement judgement is formed. A
      // missing delegate here is a runtime TypeError, not a skipped read.
      organizationMember: { findFirst: async () => null },
      // The claim/run/task/enqueue unit is `@nessie/db`'s and has its own
      // Postgres suite; here it only has to record that a reply decision got
      // as far as claiming a slot.
      $transaction: async () => {
        transactions.push(1)
        return { kind: 'pended' as const }
      },
    },
    realtimeTransport: { publishSse: async () => undefined, publishWs: async () => undefined },
  } as unknown as OrchestrateDecideDeps

  const payload = {
    actorContext: {
      actionContext: { requestId: 'decide' },
      actor: { actorId: STARTER_ID, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: ORGANIZATION_ID },
    },
    channelAgents: [researcher, reporter],
    channelId: CHANNEL_ID,
    content: 'have a look at the pricing page',
    messageId: MESSAGE_ID,
    role: 'user',
    threadId: THREAD_ID,
  } as never

  return { deps, modelCalls, payload, transactions }
}

test('a conversation turn never reaches the engagement model', async () => {
  const fixture = decideFixture({ agentId: researcher.id, startedByUserId: STARTER_ID })
  await executeOrchestrateDecideJob(fixture.deps, fixture.payload)

  assert.deepEqual(fixture.modelCalls, [])
  // Exactly one reply decision was acted on: the conversation's own agent.
  assert.equal(fixture.transactions.length, 1)
})

test('the same turn in a General thread does reach the engagement model', async () => {
  const fixture = decideFixture({ agentId: null, startedByUserId: null })
  await executeOrchestrateDecideJob(fixture.deps, fixture.payload)

  assert.deepEqual(fixture.modelCalls, ['chat'])
})
