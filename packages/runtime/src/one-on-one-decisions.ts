import type { ChannelDecisionChoice } from '@nessie/schemas'

import type { DecisionAnswer, DecisionModelClient, DecisionQuestion } from './decision-model.js'
import type { LedgerAttribution } from './ledger.js'

/**
 * One person and one agent: every message is addressed to the agent, so there
 * is no engagement question to ask — only how the agent should answer, and
 * whether the message goes back to something said earlier.
 *
 * Jev judges both in one evaluation, before the run starts, so the reply's
 * place is settled before its first thinking token
 * (docs/standards/reply-threads.md → "One-on-one rooms"). Every uncertain
 * choice falls back to the plain answer — a written reply in the main chat —
 * because a one-on-one message must never go unanswered on a classifier's
 * doubt.
 */

/** A top-level message the latest one may go back to. */
export type OneOnOneEarlierMessage = {
  id: string
  /** Whose words these are, from the person's side of the chat. */
  author: 'person' | 'agent'
  content: string
}

/**
 * How an answer that goes back to an earlier message points at it: named in
 * words, linked from the main chat, or posted under it as a thread.
 */
export type OneOnOneReference = 'mention' | 'link' | 'thread'

export type OneOnOneJudgement =
  | { shape: 'acknowledge'; emoji: string }
  | {
      /**
       * `reply` writes an answer; `act` does what was asked with the agent's
       * tools and marks the message done instead of writing about it.
       */
      shape: 'reply' | 'act'
      earlier?: { messageId: string; reference: OneOnOneReference }
    }

/** Below this, a choice is treated as not made. The channel policy's starter value. */
export const ONE_ON_ONE_MINIMUM_PROBABILITY = 0.8

/** The reactions an acknowledgement may use, keyed by the choice Jev returns. */
export const ONE_ON_ONE_REACTIONS = {
  agree: '👍',
  celebrate: '🎉',
  thanks: '❤️',
} as const

/** The acknowledgement for an uncertain reaction choice: neutral, never wrong. */
const DEFAULT_REACTION = ONE_ON_ONE_REACTIONS.agree

const excerpt = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)} [excerpt]`

const choice = (instructions: string, criteria: Record<string, string>): DecisionQuestion =>
  ({ type: 'choice', instructions, criteria })

const earlierKey = (index: number): string => `m${index + 1}`

const questionsFor = (earlier: readonly OneOnOneEarlierMessage[]): Record<string, DecisionQuestion> => ({
  response: choice('How should the agent respond to the latest message?', {
    reply: 'With a written answer: the person asks something, wants information, '
      + 'or wants to read what the agent did.',
    act: 'By doing what was asked with its tools and marking the message done; '
      + 'the outcome needs no written reply.',
    acknowledge: 'With a reaction only: thanks, an FYI or a settled decision that '
      + 'needs nothing done and nothing said.',
  }),
  reaction: choice('If the agent only reacts, which reaction fits the latest message?', {
    agree: `${ONE_ON_ONE_REACTIONS.agree} Agreement, a confirmation or a noted FYI.`,
    celebrate: `${ONE_ON_ONE_REACTIONS.celebrate} Good news or a success.`,
    thanks: `${ONE_ON_ONE_REACTIONS.thanks} Thanks or appreciation.`,
  }),
  ...(earlier.length > 0
    ? {
        earlier: choice(
          'Does the latest message go back to one of these earlier messages — asking about '
          + 'it again, correcting it, or picking up what it started — rather than carrying on '
          + 'from the most recent turns?',
          {
            none: 'No. It carries on the current conversation.',
            ...Object.fromEntries(earlier.map((message, index) => [
              earlierKey(index),
              `${message.author === 'person' ? 'The person' : 'The agent'}: ${excerpt(message.content, 280)}`,
            ])),
          },
        ),
        reference: choice('If it goes back to an earlier message, how should the answer point to it?', {
          mention: 'Answer here in the main chat and mention the earlier message in words.',
          link: 'Answer here in the main chat with a visible link to the earlier message, '
            + 'so the person can jump back to it.',
          thread: 'Answer under the earlier message as a thread, because the answer belongs '
            + 'with that discussion rather than here.',
        }),
      }
    : {}),
})

const confident = (answers: Record<string, DecisionAnswer>, id: string): string | undefined => {
  const answer = answers[id]
  return answer && (answer.probabilities[answer.choice] ?? 0) >= ONE_ON_ONE_MINIMUM_PROBABILITY
    ? answer.choice
    : undefined
}

const isReference = (value: string | undefined): value is OneOnOneReference =>
  value === 'mention' || value === 'link' || value === 'thread'

export const judgeOneOnOneTurn = async (
  client: DecisionModelClient,
  input: {
    agent: { name: string; role: string; systemPrompt: string | null }
    /** The latest message, with any attachment inventory already appended. */
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
    /**
     * Candidates for "goes back to", oldest first. Empty when the latest
     * message is itself inside a reply thread: it has already chosen its place.
     */
    earlierMessages: readonly OneOnOneEarlierMessage[]
    timeoutMs?: number
    usage: LedgerAttribution
  },
): Promise<{ choices: ChannelDecisionChoice[]; judgement: OneOnOneJudgement }> => {
  const questions = questionsFor(input.earlierMessages)
  const answers = await client.evaluate({
    state: {
      chat: 'A one-on-one chat between one person and their agent. '
        + 'Every message the person writes is addressed to the agent.',
      agent: `${excerpt(input.agent.name, 120)}: ${excerpt(input.agent.role, 250)}. `
        + excerpt(input.agent.systemPrompt ?? '', 600),
      latest_message: input.content,
      recent_messages: input.recentMessages.slice(-5).map((message) => ({
        ...message, content: excerpt(message.content, 1600),
      })),
    },
    questions,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    usage: input.usage,
  })
  const choices = Object.keys(questions).map((questionId) => {
    const answer = answers[questionId]!
    const probability = answer.probabilities[answer.choice] ?? 0
    return {
      questionId,
      choice: answer.choice,
      probability,
      meetsThreshold: probability >= ONE_ON_ONE_MINIMUM_PROBABILITY,
    }
  })

  const response = confident(answers, 'response')
  if (response === 'acknowledge') {
    const reaction = confident(answers, 'reaction')
    const emoji = reaction && reaction in ONE_ON_ONE_REACTIONS
      ? ONE_ON_ONE_REACTIONS[reaction as keyof typeof ONE_ON_ONE_REACTIONS]
      : DEFAULT_REACTION
    return { choices, judgement: { shape: 'acknowledge', emoji } }
  }

  const shape = response === 'act' ? 'act' : 'reply'
  const target = input.earlierMessages.find(
    (_message, index) => earlierKey(index) === confident(answers, 'earlier'),
  )
  if (!target) return { choices, judgement: { shape } }
  const reference = confident(answers, 'reference')
  return {
    choices,
    judgement: {
      shape,
      earlier: { messageId: target.id, reference: isReference(reference) ? reference : 'mention' },
    },
  }
}
