import type { ChannelDecisionChoice } from '@nessie/schemas'

import type { DecisionAnswer, DecisionQuestion } from './decision-model.js'

/**
 * The small vocabulary every Jev caller builds its questions from, so a
 * question, its evidence and the threshold that makes an answer count are
 * written the same way wherever Nessie asks one.
 */

/** A choice question: Jev returns one option and a probability for every option. */
export const choice = (instructions: string, criteria: Record<string, string>): DecisionQuestion =>
  ({ type: 'choice', instructions, criteria })

/** Evidence text cut to size, marked so the classifier knows it is partial. */
export const excerpt = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit)} [excerpt]`

/** The chosen option when its probability reaches `minimum`; otherwise no choice. */
export const confidentChoice = (
  answers: Record<string, DecisionAnswer>, id: string, minimum: number,
): string | undefined => {
  const answer = answers[id]
  return answer && (answer.probabilities[answer.choice] ?? 0) >= minimum ? answer.choice : undefined
}

/** Every answer in the shape a decision snapshot records it. */
export const evaluatedChoices = (
  questions: Record<string, DecisionQuestion>,
  answers: Record<string, DecisionAnswer>,
  minimum: number,
): ChannelDecisionChoice[] =>
  Object.keys(questions).map((questionId) => {
    const answer = answers[questionId]!
    const probability = answer.probabilities[answer.choice] ?? 0
    return { questionId, choice: answer.choice, probability, meetsThreshold: probability >= minimum }
  })

/**
 * The reactions Nessie's own decisions may place without a configured policy,
 * keyed by the choice Jev returns. A channel policy brings its own list.
 */
export const DECISION_REACTIONS = {
  agree: '👍',
  celebrate: '🎉',
  thanks: '❤️',
} as const

export type DecisionReaction = keyof typeof DECISION_REACTIONS

export const reactionQuestion = (instructions: string): DecisionQuestion => choice(instructions, {
  agree: `${DECISION_REACTIONS.agree} Agreement, a confirmation or a noted FYI.`,
  celebrate: `${DECISION_REACTIONS.celebrate} Good news or a success.`,
  thanks: `${DECISION_REACTIONS.thanks} Thanks or appreciation.`,
})

/** The reaction for a choice; an uncertain one is 👍, which is neutral and never wrong. */
export const reactionFor = (value: string | undefined): string =>
  value !== undefined && Object.hasOwn(DECISION_REACTIONS, value)
    ? DECISION_REACTIONS[value as DecisionReaction]
    : DECISION_REACTIONS.agree
