import type { DecisionAnswer, DecisionQuestion } from './decision-model.js'
import { choice, confidentChoice, excerpt } from './decision-questions.js'
import type { ProviderMessage } from './inference/types.js'

/**
 * Jev in front of a run's own utility judgements. Each judge answers the
 * clear cases and stands aside on the rest: `null` means "ask the generative
 * judge as before", never "no". The run binds attribution and routing; a run
 * whose inference must stay on a personal subscription or a local model has no
 * evaluator at all (docs/standards/tech-and-run-budgets.md → "Jev gates").
 */
export type RunDecisionEvaluator = (input: {
  state: Record<string, unknown>
  questions: Record<string, DecisionQuestion>
  timeoutMs?: number
}) => Promise<Record<string, DecisionAnswer>>

/**
 * How sure Jev must be that an answer is finished before the generative
 * completion review is skipped. Higher than the room-level 0.8: a wrong skip
 * ends a turn with work undone, which the person then has to notice.
 */
export const COMPLETION_MINIMUM_PROBABILITY = 0.9

/** Below this, a watch disposition is left to the generative classifier. */
export const WATCH_DISPOSITION_MINIMUM_PROBABILITY = 0.8

/** The generative judge is still there, so Jev is not waited on long. */
const RUN_DECISION_TIMEOUT_MS = 4_000

// Jev reads at most ~24 KB per question including its state. The digest is
// built to stay well inside that, dropping the oldest work steps first.
const DIGEST_BUDGET_BYTES = 18_000

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

type WorkStep = { tool: string; arguments: string; result?: string } | { said: string }

/**
 * The evidence a completion judgement needs, and nothing else: what was
 * asked, the turns just before it (so "yes, do it" has a referent), what the
 * agent did since, and the answer it proposes to end with.
 */
export const completionDigest = (
  messages: readonly ProviderMessage[],
  proposedAnswer: string,
): Record<string, unknown> => {
  let requestIndex = messages.length - 1
  while (requestIndex >= 0 && messages[requestIndex]!.role !== 'user') requestIndex -= 1
  const request = requestIndex >= 0 ? messages[requestIndex]!.content ?? '' : ''
  const before = messages.slice(0, Math.max(requestIndex, 0))
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content)
    .slice(-4)
    .map((message) => ({ role: message.role, content: excerpt(message.content ?? '', 500) }))
  const results = new Map<string, string>()
  for (const message of messages.slice(requestIndex + 1)) {
    if (message.role === 'tool') results.set(message.toolCallId, message.content)
  }
  const steps: WorkStep[] = []
  for (const message of messages.slice(requestIndex + 1)) {
    if (message.role !== 'assistant') continue
    if (message.content?.trim()) steps.push({ said: excerpt(message.content, 400) })
    for (const call of message.toolCalls ?? []) {
      const result = results.get(call.toolCallId)
      steps.push({
        tool: call.toolName,
        arguments: excerpt(JSON.stringify(call.arguments), 400),
        ...(result === undefined ? {} : { result: excerpt(result, 800) }),
      })
    }
  }
  const digest = {
    conventions: 'An answer that is only ✅ reports that the work was done without writing about it.',
    latest_request: excerpt(request, 4_000),
    conversation_before_it: before,
    work_this_turn: steps,
    proposed_answer: excerpt(proposedAnswer, 6_000),
  }
  let omitted = 0
  while (steps.length > 0 && bytes(digest) > DIGEST_BUDGET_BYTES) {
    steps.shift()
    omitted += 1
  }
  return omitted > 0 ? { ...digest, earlier_work_steps_omitted: omitted } : digest
}

const COMPLETION_QUESTION = choice(
  'The agent proposes to end its turn with proposed_answer. Has it finished what the latest '
  + 'request asked of it?',
  {
    complete: 'Yes. The answer gives the result, reports work that was actually done, asks a question '
      + 'the agent genuinely needs answered, or names a blocker only the person or an outside event can clear.',
    unfinished: 'No. The answer only promises, plans or announces work that was not done, says what it '
      + 'will do next, or a tool result leaves an authorized step undone or failed without saying so.',
  },
)

/**
 * `true` when Jev is sure the proposed answer finishes the turn, so the
 * generative review would only confirm it. Never `false`: a run that may be
 * unfinished is exactly the case the generative review exists for, and its
 * written reason is what the continuing turn is told.
 */
export const judgeAnswerComplete = async (
  evaluate: RunDecisionEvaluator,
  messages: readonly ProviderMessage[],
  proposedAnswer: string,
): Promise<true | null> => {
  const state = completionDigest(messages, proposedAnswer)
  if (bytes(state) > DIGEST_BUDGET_BYTES) return null
  try {
    const answers = await evaluate({
      state, questions: { completion: COMPLETION_QUESTION }, timeoutMs: RUN_DECISION_TIMEOUT_MS,
    })
    return confidentChoice(answers, 'completion', COMPLETION_MINIMUM_PROBABILITY) === 'complete' ? true : null
  } catch {
    return null
  }
}

const WATCH_QUESTION = choice('How should this monitoring sweep\'s result be delivered?', {
  post: 'As a new message: it found something a person should see now — a new problem, a change '
    + 'since last time, something escalating, or anything needing action.',
  status: 'As a quiet rolling status line: nothing new — the same state as before, everything '
    + 'healthy, nothing to act on.',
})

/** `post` or `status` when Jev is sure; `null` leaves it to the generative classifier. */
export const judgeWatchDisposition = async (
  evaluate: RunDecisionEvaluator,
  responseText: string,
): Promise<'post' | 'status' | null> => {
  try {
    const answers = await evaluate({
      state: { sweep_result: excerpt(responseText, 4_000) },
      questions: { disposition: WATCH_QUESTION },
      timeoutMs: RUN_DECISION_TIMEOUT_MS,
    })
    const disposition = confidentChoice(answers, 'disposition', WATCH_DISPOSITION_MINIMUM_PROBABILITY)
    return disposition === 'post' || disposition === 'status' ? disposition : null
  } catch {
    return null
  }
}
