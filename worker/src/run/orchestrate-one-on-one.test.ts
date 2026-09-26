import assert from 'node:assert/strict'
import test from 'node:test'

import type { DecisionAnswer, DecisionModelClient, DecisionQuestion } from '@nessie/runtime'

import { executeOrchestrateDecideJob, type OrchestrateDecideDeps } from './orchestrate.js'
import {
  answerInMainChat,
  decideOneOnOneTurn,
  isOneOnOneAgentRoom,
  isSinglePersonRoom,
} from './orchestrate-one-on-one.js'

/**
 * One-on-one rooms (docs/standards/reply-threads.md → "One-on-one rooms").
 *
 * Jev is faked here: what is under test is what the orchestrator asks it, what
 * it does with each answer, and that every doubt ends in the plain answer — a
 * written reply in the main chat. The fixture turns are Czech, slang and
 * misspelled on purpose: nothing here may depend on reading them.
 */

const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000b1'
const DM_ID = '00000000-0000-4000-8000-0000000000b2'
const THREAD_ID = '00000000-0000-4000-8000-0000000000b3'
const TRIGGER_ID = '00000000-0000-4000-8000-0000000000b4'
const PERSON_ID = '00000000-0000-4000-8000-0000000000b5'
const AGENT_ID = '00000000-0000-4000-8000-0000000000b6'
const OTHER_AGENT_ID = '00000000-0000-4000-8000-0000000000b7'
const E1 = '00000000-0000-4000-8000-0000000000c1'
const E2 = '00000000-0000-4000-8000-0000000000c2'
const E3 = '00000000-0000-4000-8000-0000000000c3'
const E4 = '00000000-0000-4000-8000-0000000000c4'

const agent = { id: AGENT_ID, name: 'Ledger Clerk', role: 'assistant', systemPrompt: 'Keeps the books.' }

const at = (minute: number) => new Date(`2026-09-26T10:${String(minute).padStart(2, '0')}:00.000Z`)

const personTurn = (id: string, content: string, minute: number) => ({
  agentId: null, content, createdAt: at(minute), id, metadata: null, onBehalfOfUserId: null,
  role: 'user', userId: PERSON_ID, agent: null, basisScopes: [], disclosureSources: [],
})
const agentTurn = (id: string, content: string, minute: number) => ({
  agentId: AGENT_ID, content, createdAt: at(minute), id, metadata: null, onBehalfOfUserId: null,
  role: 'assistant', userId: null, agent: { name: agent.name }, basisScopes: [],
  disclosureSources: [{ sourceAuthorUserId: PERSON_ID, sourceChannelId: DM_ID }],
})

/** The main chat above the latest message, oldest first. */
const MAIN_CHAT = [
  personTurn(E1, 'launch je 12. října, zapamatuj si to', 1),
  agentTurn(E2, 'Noted — launch on 12 October.', 2),
  personTurn(E3, 'ok lets plan teh blog post', 3),
  agentTurn(E4, 'Here is a first outline for the post.', 4),
]

type Evaluation = { questions: Record<string, DecisionQuestion>; state: Record<string, unknown> }

/** A fake Jev: each question is answered with the given choice at the given probability. */
const jev = (answers: Record<string, [string, number]>) => {
  const calls: Evaluation[] = []
  const client: DecisionModelClient = {
    evaluate: async (input) => {
      calls.push({ questions: input.questions, state: input.state })
      return Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
        const [picked, probability] = answers[id] ?? [Object.keys(question.criteria)[0]!, 0.5]
        const others = Object.keys(question.criteria).filter((key) => key !== picked)
        const answer: DecisionAnswer = {
          type: 'choice',
          choice: picked,
          probabilities: {
            [picked]: probability,
            ...Object.fromEntries(others.map((key) => [key, (1 - probability) / others.length])),
          },
        }
        return [id, answer]
      }))
    },
  }
  return { calls, client }
}

const payload = (content: string) => ({
  actorContext: {
    actionContext: { requestId: 'one-on-one' },
    actor: { actorId: PERSON_ID, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: ORGANIZATION_ID },
  },
  channelAgents: [agent],
  channelId: DM_ID,
  content,
  messageId: TRIGGER_ID,
  role: 'user',
  threadId: THREAD_ID,
}) as never

const trigger = (overrides: { channelDecision?: unknown; rootMessageId?: string | null } = {}) => ({
  channelDecision: overrides.channelDecision ?? null,
  createdAt: at(5),
  id: TRIGGER_ID,
  rootMessageId: overrides.rootMessageId ?? null,
})

const windowPrisma = (options: { claimed?: boolean; pinnedByOther?: unknown } = {}) => {
  const reads: unknown[] = []
  const pinned: unknown[] = []
  const prisma = {
    attachment: { findMany: async () => [] },
    message: {
      // Prisma hands the window back newest first.
      findMany: async (query: unknown) => {
        reads.push(query)
        return [...MAIN_CHAT].reverse()
      },
      findUniqueOrThrow: async () => ({ channelDecision: options.pinnedByOther }),
      updateMany: async ({ data }: { data: { channelDecision: unknown } }) => {
        pinned.push(data.channelDecision)
        return { count: options.claimed === false ? 0 : 1 }
      },
    },
    // The person's live visibility in a local organisation with no IdP: an
    // active member of this DM and nothing else. A denied viewer would see no
    // turn at all, which is a different test.
    agent: { findMany: async () => [] },
    channel: { findFirst: async () => null, findMany: async () => [] },
    channelMember: { findMany: async () => [{ channelId: DM_ID }] },
    organization: { findUnique: async () => ({ externalOrgId: null }) },
    organizationMember: { findFirst: async () => ({ id: 'membership' }) },
    productAccountLink: { findUnique: async () => null },
    projectMember: { findMany: async () => [] },
    teamMember: { findMany: async () => [] },
  }
  return { pinned, prisma: prisma as never, reads }
}

const decide = (
  deps: { decisionClient?: DecisionModelClient; prisma: never },
  content: string,
  overrides: Parameters<typeof trigger>[0] = {},
) => decideOneOnOneTurn(deps, {
  agent,
  channel: { organizationId: ORGANIZATION_ID, visibility: 'private' },
  payload: payload(content),
  trigger: trigger(overrides),
})

test('a room with one person and one agent is one-on-one; anything else is not', () => {
  const dm = { memberCount: 1, systemChannelType: null, type: 'dm' }
  assert.equal(isOneOnOneAgentRoom(dm, [agent]), true)
  assert.equal(isOneOnOneAgentRoom({ ...dm, systemChannelType: 'personal_assistant' }, [agent]), true)
  // Two agents: the message is not structurally addressed to either.
  assert.equal(isOneOnOneAgentRoom(dm, [agent, { ...agent, id: OTHER_AGENT_ID }]), false)
  // A person-to-person DM and a one-member channel both have somebody else in or near them.
  assert.equal(isOneOnOneAgentRoom({ ...dm, memberCount: 2 }, [agent]), false)
  assert.equal(isOneOnOneAgentRoom({ ...dm, type: 'standard' }, [agent]), false)
  // An external agent's every turn is proxied to its own product.
  assert.equal(isOneOnOneAgentRoom({ ...dm, systemChannelType: 'external_agent' }, [agent]), false)
  // Placement only asks who is in the room.
  assert.equal(isSinglePersonRoom({ memberCount: 1, type: 'dm' }), true)
  assert.equal(isSinglePersonRoom({ memberCount: 3, type: 'dm' }), false)
})

test('the fallback answers every reply in the main chat and leaves reactions alone', () => {
  assert.deepEqual(answerInMainChat([
    { action: 'reply', agentId: AGENT_ID, replyPlacement: 'thread' },
    { action: 'acknowledge', agentId: AGENT_ID, emoji: '👍' },
  ]), [
    { action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel' },
    { action: 'acknowledge', agentId: AGENT_ID, emoji: '👍' },
  ])
})

test('going back to an earlier message can put the answer under it as a thread', async () => {
  const judge = jev({ response: ['reply', 0.93], earlier: ['m1', 0.9], reference: ['thread', 0.86] })
  const room = windowPrisma()
  const decisions = await decide({ decisionClient: judge.client, prisma: room.prisma }, 'wait wat was the launch date again??')

  assert.deepEqual(decisions, [{
    action: 'reply', agentId: AGENT_ID, replyPlacement: 'thread',
    earlierMessageId: E1, earlierReference: 'thread',
  }])
  const asked = judge.calls[0]!
  assert.deepEqual(Object.keys(asked.questions), ['response', 'reaction', 'earlier', 'reference'])
  // The exchange immediately above the latest message is where a reply already
  // sits, so only the turns before it are offered as "earlier".
  assert.deepEqual(Object.keys(asked.questions.earlier!.criteria), ['none', 'm1', 'm2'])
  assert.match(asked.questions.earlier!.criteria.m1!, /^The person: launch je 12\. října/)
  assert.match(asked.questions.earlier!.criteria.m2!, /^The agent: Noted/)
  assert.equal(asked.state.latest_message, 'wait wat was the launch date again??')
  // Only the main chat is read for a top-level message.
  assert.deepEqual((room.reads[0] as { where: { rootMessageId: unknown } }).where.rootMessageId, null)
})

test('the judgement is pinned once, with what Jev read as its lineage', async () => {
  const judge = jev({ response: ['reply', 0.93], earlier: ['m1', 0.9], reference: ['thread', 0.86] })
  const room = windowPrisma()
  await decide({ decisionClient: judge.client, prisma: room.prisma }, 'wait wat was the launch date again??')

  const snapshot = room.pinned[0] as Record<string, unknown>
  assert.equal(snapshot.policyFingerprint, 'one-on-one')
  assert.equal(snapshot.authorizer, null)
  assert.deepEqual(snapshot.basisScopes, [])
  // The person's own words in their private DM, once — exactly what the
  // transcript would admit for the same turns.
  assert.deepEqual(snapshot.disclosureSources, [{ sourceAuthorUserId: PERSON_ID, sourceChannelId: DM_ID }])
  assert.deepEqual(
    (snapshot.choices as Array<{ questionId: string; meetsThreshold: boolean }>)
      .map(({ questionId, meetsThreshold }) => [questionId, meetsThreshold]),
    [['response', true], ['reaction', false], ['earlier', true], ['reference', true]],
  )
})

test('a link keeps the answer in the main chat and names the earlier message', async () => {
  const judge = jev({ response: ['reply', 0.9], earlier: ['m2', 0.88], reference: ['link', 0.91] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'jak jsme to měli s tím launchem?')

  assert.deepEqual(decisions, [{
    action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel',
    earlierMessageId: E2, earlierReference: 'link',
  }])
})

test('an unsure reference choice mentions the earlier message in words', async () => {
  const judge = jev({ response: ['reply', 0.9], earlier: ['m1', 0.9], reference: ['thread', 0.6] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'the launch thing again?')

  assert.deepEqual(decisions, [{
    action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel',
    earlierMessageId: E1, earlierReference: 'mention',
  }])
})

test('a thank-you is acknowledged with the reaction Jev chose, and nothing runs', async () => {
  const judge = jev({ response: ['acknowledge', 0.95], reaction: ['thanks', 0.9] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'díky moc!!')

  assert.deepEqual(decisions, [{ action: 'acknowledge', agentId: AGENT_ID, emoji: '❤️' }])
})

test('an acknowledgement with an unsure reaction still gets a neutral one', async () => {
  const judge = jev({ response: ['acknowledge', 0.95], reaction: ['celebrate', 0.4] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'k cool')

  assert.deepEqual(decisions, [{ action: 'acknowledge', agentId: AGENT_ID, emoji: '👍' }])
})

test('a request to do something is done and marked, not written about', async () => {
  const judge = jev({ response: ['act', 0.9] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'pls add mléko to my shoping list')

  assert.deepEqual(decisions, [{
    action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel', acknowledgeWhenDone: true,
  }])
})

test('every uncertain choice ends in a written answer in the main chat', async () => {
  const judge = jev({ response: ['acknowledge', 0.6], earlier: ['m1', 0.7], reference: ['thread', 0.95] })
  const decisions = await decide({ decisionClient: judge.client, prisma: windowPrisma().prisma }, 'hmm')

  assert.deepEqual(decisions, [{ action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel' }])
})

test('a message inside a reply thread keeps its thread and is offered nothing earlier', async () => {
  const judge = jev({ response: ['reply', 0.9] })
  const room = windowPrisma()
  const decisions = await decide(
    { decisionClient: judge.client, prisma: room.prisma },
    'a ještě jedna věc k tomu',
    { rootMessageId: E1 },
  )

  assert.deepEqual(decisions, [{ action: 'reply', agentId: AGENT_ID, replyPlacement: 'thread' }])
  assert.deepEqual(Object.keys(judge.calls[0]!.questions), ['response', 'reaction'])
  assert.deepEqual(
    (room.reads[0] as { where: { OR: unknown } }).where.OR,
    [{ id: E1 }, { rootMessageId: E1 }],
  )
})

test('without an evaluation client there is no judgement and nothing is read', async () => {
  const room = windowPrisma()
  assert.equal(await decide({ prisma: room.prisma }, 'hello?'), null)
  assert.deepEqual(room.reads, [])
})

test('a failed evaluation leaves the room its structural answer', async () => {
  const room = windowPrisma()
  const client: DecisionModelClient = {
    evaluate: async () => { throw new Error('token not allowed for vercel') },
  }
  assert.equal(await decide({ decisionClient: client, prisma: room.prisma }, 'hello?'), null)
  assert.deepEqual(room.pinned, [])
})

const pinned = (decisions: unknown[]) => ({
  policyFingerprint: 'one-on-one',
  authorizer: null,
  basisScopes: [],
  disclosureSources: [],
  decisions,
})

test('a redelivered turn reads its pinned judgement back instead of judging again', async () => {
  const judge = jev({ response: ['reply', 0.9] })
  const decisions = await decide(
    { decisionClient: judge.client, prisma: windowPrisma().prisma },
    'wait wat was the launch date again??',
    { channelDecision: pinned([{ action: 'acknowledge', agentId: AGENT_ID, emoji: '🎉' }]) },
  )

  assert.deepEqual(decisions, [{ action: 'acknowledge', agentId: AGENT_ID, emoji: '🎉' }])
  assert.deepEqual(judge.calls, [])
})

test('a pinned judgement for another agent is no judgement for this room', async () => {
  const decisions = await decide(
    { decisionClient: jev({}).client, prisma: windowPrisma().prisma },
    'hello?',
    { channelDecision: pinned([{ action: 'reply', agentId: OTHER_AGENT_ID, replyPlacement: 'channel' }]) },
  )
  assert.equal(decisions, null)
})

test('a channel policy’s snapshot is never read back as a one-on-one judgement', async () => {
  const decisions = await decide(
    { decisionClient: jev({}).client, prisma: windowPrisma().prisma },
    'hello?',
    {
      channelDecision: {
        ...pinned([{ action: 'reply', agentId: AGENT_ID, policyWork: true, promptOverride: 'Do the work.' }]),
        policyFingerprint: 'sha256-of-a-channel-policy',
      },
    },
  )
  assert.equal(decisions, null)
})

test('when a concurrent delivery pinned first, its judgement is the answer', async () => {
  const judge = jev({ response: ['act', 0.9] })
  const room = windowPrisma({
    claimed: false,
    pinnedByOther: pinned([{ action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel' }]),
  })
  const decisions = await decide({ decisionClient: judge.client, prisma: room.prisma }, 'udělej to')
  assert.deepEqual(decisions, [{ action: 'reply', agentId: AGENT_ID, replyPlacement: 'channel' }])
})

/**
 * The same rules end to end through `executeOrchestrateDecideJob`, down to the
 * run row the dispatch writes — the placement a run is created with is what the
 * room actually shows.
 */
const roomFixture = (options: {
  channel: { memberCount: number; systemChannelType?: string | null; type: 'dm' | 'standard' }
  decisionClient?: DecisionModelClient
  modelAnswer?: string
  /** The trigger is the answer to this agent's card, pressed under it. */
  pressedCardOf?: string
}) => {
  const modelCalls: string[] = []
  const runs: Array<{ replyPlacement: string | null }> = []
  const tx = {
    $executeRaw: async () => 1,
    run: {
      findFirst: async () => null,
      create: async ({ data }: { data: { replyPlacement: string | null } }) => {
        runs.push({ replyPlacement: data.replyPlacement })
        return { agentId: AGENT_ID, id: '00000000-0000-4000-8000-0000000000d1', status: 'pending', threadId: THREAD_ID }
      },
    },
    runThreadPendingMessage: { findFirst: async () => null, create: async () => ({}) },
    task: { create: async () => ({ id: '00000000-0000-4000-8000-0000000000d2' }) },
  }
  const room = windowPrisma()
  const deps = {
    ...(options.decisionClient ? { decisionClient: options.decisionClient } : {}),
    modelClient: {
      chat: async () => {
        modelCalls.push('chat')
        return options.modelAnswer ?? '{"action":"none"}'
      },
    },
    prisma: {
      ...(room.prisma as object),
      budget: { findMany: async () => [] },
      channel: {
        findFirst: async () => null,
        findMany: async () => [],
        findUnique: async () => ({
          _count: { members: options.channel.memberCount },
          archivedAt: null,
          decisionPolicy: null,
          decisionPolicyAuthorizer: null,
          deletedAt: null,
          organizationId: ORGANIZATION_ID,
          systemChannelType: options.channel.systemChannelType ?? null,
          type: options.channel.type,
          visibility: 'private',
        }),
      },
      message: {
        ...(room.prisma as { message: object }).message,
        findUnique: async () => ({
          basisScopes: [],
          channelDecision: null,
          createdAt: at(5),
          id: TRIGGER_ID,
          role: 'user',
          rootMessageId: options.pressedCardOf ? CARD_MESSAGE_ID : null,
          thread: { agentId: null, startedByUserId: null },
          threadId: THREAD_ID,
        }),
      },
      agentCard: {
        findUnique: async ({ where }: { where: { responseMessageId: string } }) =>
          options.pressedCardOf && where.responseMessageId === TRIGGER_ID
            ? { agentId: options.pressedCardOf }
            : null,
      },
      $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx),
    },
    realtimeTransport: { publishSse: async () => undefined, publishWs: async () => undefined },
  } as unknown as OrchestrateDecideDeps
  return { deps, modelCalls, runs }
}

const threadedModelAnswer = JSON.stringify({ action: 'reply', agentId: AGENT_ID, replyPlacement: 'thread' })
const CARD_MESSAGE_ID = '00000000-0000-4000-8000-0000000000c1'

test('a card press wakes the card’s agent without asking Jev or the model', async () => {
  // Jev would only react to "Allow" — which would leave the agent that asked waiting.
  const judge = jev({ response: ['acknowledge', 0.99], engagement: ['none', 0.99] })
  for (const channel of [
    { memberCount: 1, type: 'dm' as const },
    { memberCount: 3, type: 'standard' as const },
  ]) {
    const fixture = roomFixture({
      channel, decisionClient: judge.client, modelAnswer: JSON.stringify({ action: 'none' }), pressedCardOf: AGENT_ID,
    })
    await executeOrchestrateDecideJob(fixture.deps, payload('Allow · Env: prod'))

    assert.deepEqual(fixture.modelCalls, [])
    assert.deepEqual(fixture.runs, [{ replyPlacement: 'thread' }])
  }
  assert.deepEqual(judge.calls, [])
})

test('a reply that answers no card is judged as before', async () => {
  const fixture = roomFixture({
    channel: { memberCount: 3, type: 'standard' },
    modelAnswer: JSON.stringify({ action: 'none' }),
    pressedCardOf: '00000000-0000-4000-8000-0000000000ff',
  })
  await executeOrchestrateDecideJob(fixture.deps, payload('Allow'))

  // The card belongs to an agent that is not in the room: nothing structural to wake.
  assert.deepEqual(fixture.modelCalls, ['chat'])
  assert.deepEqual(fixture.runs, [])
})

test('a one-on-one turn Jev judged never reaches the engagement model', async () => {
  const fixture = roomFixture({
    channel: { memberCount: 1, type: 'dm' },
    decisionClient: jev({ response: ['reply', 0.9] }).client,
    modelAnswer: threadedModelAnswer,
  })
  await executeOrchestrateDecideJob(fixture.deps, payload('co mám dnes na práci?'))

  assert.deepEqual(fixture.modelCalls, [])
  assert.deepEqual(fixture.runs, [{ replyPlacement: 'channel' }])
})

test('without Jev an agent DM keeps its engagement judgement but answers in the main chat', async () => {
  const fixture = roomFixture({ channel: { memberCount: 1, type: 'dm' }, modelAnswer: threadedModelAnswer })
  await executeOrchestrateDecideJob(fixture.deps, payload('co mám dnes na práci?'))

  assert.deepEqual(fixture.modelCalls, ['chat'])
  assert.deepEqual(fixture.runs, [{ replyPlacement: 'channel' }])
})

test('a shared room is never judged by Jev and keeps its reply thread', async () => {
  const judge = jev({ response: ['reply', 0.9] })
  const fixture = roomFixture({
    channel: { memberCount: 3, type: 'standard' },
    decisionClient: judge.client,
    modelAnswer: threadedModelAnswer,
  })
  await executeOrchestrateDecideJob(fixture.deps, payload('can someone check the invoice?'))

  assert.deepEqual(judge.calls, [])
  assert.deepEqual(fixture.runs, [{ replyPlacement: 'thread' }])
})

test('a DM between two people is a shared room too', async () => {
  const judge = jev({ response: ['reply', 0.9] })
  const fixture = roomFixture({
    channel: { memberCount: 2, type: 'dm' },
    decisionClient: judge.client,
    modelAnswer: threadedModelAnswer,
  })
  await executeOrchestrateDecideJob(fixture.deps, payload('can u check the invoice'))

  assert.deepEqual(judge.calls, [])
  assert.deepEqual(fixture.runs, [{ replyPlacement: 'thread' }])
})
