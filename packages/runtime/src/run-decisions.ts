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
 * Whether a `user` turn is one the person wrote. Only the run can say: a
 * tool's pictures and the loop's own nudges travel as `user` turns too, and
 * taking one of those for the request would judge the answer against a
 * screenshot caption with the real request's work left out.
 */
export type PersonTurnPredicate = (message: ProviderMessage) => boolean

/**
 * The evidence a completion judgement needs, and nothing else: what was
 * asked, the turns just before it (so "yes, do it" has a referent), what the
 * agent did since, and the answer it proposes to end with. `null` when no
 * turn the person wrote is left — a transcript rebuilt by compaction or a
 * crash resume — because then there is nothing faithful to judge against.
 */
export const completionDigest = (
  messages: readonly ProviderMessage[],
  proposedAnswer: string,
  isPersonTurn: PersonTurnPredicate,
): Record<string, unknown> | null => {
  const personal = (message: ProviderMessage): boolean => message.role === 'user' && isPersonTurn(message)
  let requestIndex = messages.length - 1
  while (requestIndex >= 0 && !personal(messages[requestIndex]!)) requestIndex -= 1
  if (requestIndex < 0) return null
  const request = messages[requestIndex]!.content ?? ''
  const before = messages.slice(0, requestIndex)
    .filter((message) => (personal(message) || message.role === 'assistant') && message.content)
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
  isPersonTurn: PersonTurnPredicate,
): Promise<true | null> => {
  const state = completionDigest(messages, proposedAnswer, isPersonTurn)
  if (!state || bytes(state) > DIGEST_BUDGET_BYTES) return null
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

/**
 * How sure Jev must be that a prepared call did its job before the run ends
 * marking the answer done without the model. A wrong "done" puts ✅ on an
 * action that never happened.
 */
export const PREPARED_OUTCOME_MINIMUM_PROBABILITY = 0.9

const preparedOutcomeQuestion = (index: number) => choice(
  `The platform ran call ${index} for the person, exactly as the agent prepared it. `
  + 'Does its result show that it did what it was called to do?',
  {
    done: 'Yes: the result shows the operation happened as asked.',
    not_done: 'No: the result reports a refusal, an error, a missing permission, nothing found or '
      + 'changed, or anything short of the operation happening as asked.',
  },
)

/**
 * Whether every prepared call's result shows its operation done
 * (docs/standards/agent-cards.md → "A prepared button runs its call"). A tool
 * counts as successful whenever it returned, and several builtins return a
 * refusal as ordinary output, so that flag alone would mark a refused action
 * done. Only a sure "done" for every call ends the run without the model;
 * doubt, "not done" and any failure hand the turn to the model with the
 * results.
 */
export const judgePreparedOutcome = async (
  evaluate: RunDecisionEvaluator,
  calls: ReadonlyArray<{ tool: string; arguments: Record<string, unknown>; result: string }>,
): Promise<boolean> => {
  if (calls.length === 0) return false
  const questionIds = calls.map((_call, index) => `call_${index + 1}`)
  try {
    const answers = await evaluate({
      state: {
        calls: calls.map((call, index) => ({
          call: index + 1,
          tool: call.tool,
          arguments: excerpt(JSON.stringify(call.arguments), 1_000),
          result: excerpt(call.result, 4_000),
        })),
      },
      questions: Object.fromEntries(questionIds.map((id, index) => [id, preparedOutcomeQuestion(index + 1)])),
      timeoutMs: RUN_DECISION_TIMEOUT_MS,
    })
    return questionIds.every((id) =>
      confidentChoice(answers, id, PREPARED_OUTCOME_MINIMUM_PROBABILITY) === 'done')
  } catch {
    return false
  }
}
