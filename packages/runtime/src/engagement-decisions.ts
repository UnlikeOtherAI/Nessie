import type { DecisionModelClient, DecisionQuestion } from './decision-model.js'
import { choice, confidentChoice, excerpt, reactionFor, reactionQuestion } from './decision-questions.js'
import { isCreditsExhaustedError } from './inference/types.js'
import type { LedgerAttribution } from './ledger.js'
import type { OrchestratorAgent, OrchestratorDecision } from './orchestrator.js'

/**
 * Jev's answer to the orchestrator's everyday question — should an agent in
 * this room answer the latest human message, react to it, or stay out — for a
 * room with no channel decision policy
 * (docs/standards/channel-decision-policy.md → "Rooms without a policy").
 *
 * Jev is asked first because it answers in a few hundred milliseconds for a
 * fraction of a cent, while the generative orchestrator it stands in front of
 * reads the same evidence with a reasoning model. It never has the last word
 * on its own doubt: an answer below the threshold, a contradiction (engage,
 * but no agent) or any failure returns `null`, and the caller asks the
 * generative orchestrator exactly as before.
 */

/** Below this, a choice is treated as not made. The channel policy's starter value. */
export const ENGAGEMENT_MINIMUM_PROBABILITY = 0.8

/** The generative orchestrator is still there to answer, so Jev is not waited on long. */
const ENGAGEMENT_TIMEOUT_MS = 4_000

const candidateId = (agent: OrchestratorAgent): string => agent.engagementId ?? agent.id

const questionsFor = (agents: readonly OrchestratorAgent[]): Record<string, DecisionQuestion> => ({
  engagement: choice('Does the latest human message need a response from one of the agents in this room?', {
    reply: 'Yes, a written answer: it asks an agent something, asks for work an agent does, asks a '
      + 'question an agent here is placed to answer, or continues a conversation an agent is already part of.',
    acknowledge: 'A reaction only: it tells an agent something — thanks, an FYI, a settled decision — '
      + 'and a written reply would add nothing the person does not already have.',
    none: 'No: people are talking to each other, it greets or addresses a person, '
      + 'or it is side-chatter no agent was asked into.',
  }),
  ...(agents.length > 1
    ? {
        agent: choice('Which agent is best placed to respond to the latest message?', {
          none: 'No available agent is appropriate.',
          ...Object.fromEntries(agents.map((agent) => [candidateId(agent),
            `${excerpt(agent.name, 120)}: ${excerpt(agent.role, 250)}. `
            + excerpt(agent.systemPrompt ?? 'general assistant', 400)])),
        }),
      }
    : {}),
  placement: choice('If an agent replies, where does its answer belong?', {
    thread: 'With the latest message: it answers it, continues that exchange, or reports on what it asked for.',
    channel: 'In the room on its own: a contribution addressed to everyone rather than to that exchange.',
  }),
  reaction: reactionQuestion('If an agent only reacts, which reaction fits the latest message?'),
})

export const judgeChannelEngagement = async (
  client: DecisionModelClient,
  input: {
    agents: readonly OrchestratorAgent[]
    content: string
    recentMessages: ReadonlyArray<{ role: string; content: string; agentName?: string }>
    followingAgentIds: readonly string[]
    usage?: LedgerAttribution
  },
): Promise<OrchestratorDecision[] | null> => {
  if (!input.usage || input.agents.length === 0) return null
  const questions = questionsFor(input.agents)
  const following = new Set(input.followingAgentIds)
  let answers
  try {
    answers = await client.evaluate({
      state: {
        room: 'A channel shared by people and agents. Agents answer direct questions in their own '
          + 'working channels and stay engaged in threads they have joined, but never intrude on a '
          + 'conversation between people.',
        agents: input.agents.map((agent) => ({
          id: candidateId(agent),
          name: excerpt(agent.name, 120),
          role: excerpt(agent.role, 250),
          ...(following.has(candidateId(agent)) ? { already_participating_in_this_thread: true } : {}),
        })),
        latest_message: excerpt(input.content, 6_000),
        recent_messages: input.recentMessages.slice(-5).map((message) => ({
          ...message, content: excerpt(message.content, 600),
        })),
      },
      questions,
      timeoutMs: ENGAGEMENT_TIMEOUT_MS,
      usage: input.usage,
    })
  } catch (error) {
    // Out of credits is out of credits for the generative orchestrator too.
    if (isCreditsExhaustedError(error)) throw error
    return null
  }
  const pick = (id: string): string | undefined =>
    confidentChoice(answers, id, ENGAGEMENT_MINIMUM_PROBABILITY)
  const engagement = pick('engagement')
  if (engagement === 'none') return []
  if (engagement !== 'reply' && engagement !== 'acknowledge') return null
  const selected = input.agents.length === 1
    ? input.agents[0]
    : input.agents.find((agent) => candidateId(agent) === pick('agent'))
  if (!selected) return null
  const identity = {
    agentId: selected.id,
    ...(selected.principalUserId ? { principalUserId: selected.principalUserId } : {}),
  }
  return engagement === 'reply'
    ? [{ action: 'reply', ...identity, replyPlacement: pick('placement') === 'channel' ? 'channel' : 'thread' }]
    : [{ action: 'acknowledge', ...identity, emoji: reactionFor(pick('reaction')) }]
}
