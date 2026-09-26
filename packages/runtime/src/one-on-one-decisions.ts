import type { ChannelDecisionChoice } from '@nessie/schemas'

import type { DecisionAnswer, DecisionModelClient, DecisionQuestion } from './decision-model.js'
import {
  choice, confidentChoice, DECISION_REACTIONS, evaluatedChoices, excerpt, reactionFor, reactionQuestion,
} from './decision-questions.js'
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

/**
 * How sure Jev must be — of the button, and that it was taken exactly as
 * offered — before a typed answer runs a prepared call. Far above the reply
 * shape's 0.8: this one acts without the model reading anything.
 */
export const OFFER_ANSWER_MINIMUM_PROBABILITY = 0.95

/**
 * The agent's latest message in the main chat: a card whose buttons each run a
 * call the agent prepared (docs/standards/agent-cards.md → "A prepared button
 * runs its call"). A typed answer may choose one of them in words.
 */
export type OneOnOneOffer = {
  /** The card as the person read it. */
  text: string
  options: ReadonlyArray<{ key: string; label: string; does: string }>
}

/** The reactions an acknowledgement may use, keyed by the choice Jev returns. */
export const ONE_ON_ONE_REACTIONS = DECISION_REACTIONS

const earlierKey = (index: number): string => `m${index + 1}`
// Prefixed so a button keyed "none" can never be mistaken for the refusal.
const offerKey = (key: string): string => `b_${key}`

const offerQuestions = (offer: OneOnOneOffer): Record<string, DecisionQuestion> => ({
  offer_answer: choice(
    'The agent’s last message offered these choices as buttons. Does the latest message choose one of them?',
    {
      none: 'No: it asks something else, declines, or chooses none of them.',
      ...Object.fromEntries(offer.options.map((option) =>
        [offerKey(option.key), `${option.label}: ${excerpt(option.does, 400)}`])),
    },
  ),
  offer_exact: choice('If it chooses one, does it take that choice exactly as offered?', {
    exact: 'Yes: as offered, with no change, condition or further request.',
    changed: 'No: it changes a detail, adds a condition, or asks for something more.',
  }),
})

const questionsFor = (earlier: readonly OneOnOneEarlierMessage[]): Record<string, DecisionQuestion> => ({
  response: choice('How should the agent respond to the latest message?', {
    reply: 'With a written answer: the person asks something, wants information, '
      + 'or wants to read what the agent did.',
    act: 'By doing what was asked with its tools and marking the message done; '
      + 'the outcome needs no written reply.',
    acknowledge: 'With a reaction only: thanks, an FYI or a settled decision that '
      + 'needs nothing done and nothing said.',
  }),
  reaction: reactionQuestion('If the agent only reacts, which reaction fits the latest message?'),
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

const confident = (answers: Record<string, DecisionAnswer>, id: string): string | undefined =>
  confidentChoice(answers, id, ONE_ON_ONE_MINIMUM_PROBABILITY)

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
    /** An open card of prepared buttons the latest message may be answering. */
    offer?: OneOnOneOffer
    timeoutMs?: number
    usage: LedgerAttribution
  },
): Promise<{
  choices: ChannelDecisionChoice[]
  judgement: OneOnOneJudgement
  /** The button the latest message took, exactly as offered, when Jev is sure of both. */
  offerAnswer?: string
}> => {
  const questions = {
    ...questionsFor(input.earlierMessages),
    ...(input.offer?.options.length ? offerQuestions(input.offer) : {}),
  }
  const answers = await client.evaluate({
    state: {
      chat: 'A one-on-one chat between one person and their agent. '
        + 'Every message the person writes is addressed to the agent.',
      agent: `${excerpt(input.agent.name, 120)}: ${excerpt(input.agent.role, 250)}. `
        + excerpt(input.agent.systemPrompt ?? '', 600),
      latest_message: input.content,
      ...(input.offer ? { offered_card: excerpt(input.offer.text, 2_000) } : {}),
      recent_messages: input.recentMessages.slice(-5).map((message) => ({
        ...message, content: excerpt(message.content, 1600),
      })),
    },
    questions,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    usage: input.usage,
  })
  const choices = evaluatedChoices(questions, answers, ONE_ON_ONE_MINIMUM_PROBABILITY)
  const offered = input.offer?.options.find((option) =>
    offerKey(option.key) === confidentChoice(answers, 'offer_answer', OFFER_ANSWER_MINIMUM_PROBABILITY))
  const offerAnswer = offered
    && confidentChoice(answers, 'offer_exact', OFFER_ANSWER_MINIMUM_PROBABILITY) === 'exact'
    ? { offerAnswer: offered.key }
    : {}

  const response = confident(answers, 'response')
  if (response === 'acknowledge') {
    const emoji = reactionFor(confident(answers, 'reaction'))
    return { choices, ...offerAnswer, judgement: { shape: 'acknowledge', emoji } }
  }

  const shape = response === 'act' ? 'act' : 'reply'
  const target = input.earlierMessages.find(
    (_message, index) => earlierKey(index) === confident(answers, 'earlier'),
  )
  if (!target) return { choices, ...offerAnswer, judgement: { shape } }
  const reference = confident(answers, 'reference')
  return {
    choices,
    ...offerAnswer,
    judgement: {
      shape,
      earlier: { messageId: target.id, reference: isReference(reference) ? reference : 'mention' },
    },
  }
}
