import type { DeepWaterPendingActionErrorCode } from '@nessie/schemas'

/**
 * The words a person reads about a DeepWater research in its views (Water plan
 * amendments-fable F8): why a research did not finish, why the planner could
 * not answer, and why their last action did not go through. One table each,
 * shared by the API's views and the worker's notices, so the card, the brief
 * dialog and the thread never say two different things. UK English, plain,
 * second person, and never a vendor, model, price or infrastructure name — the
 * codes stay in the view beside the words for the client's own logic.
 */

/** Why a research did not finish, from Ledger's job error code, as a clause for a sentence. */
export const deepWaterFailureMessage = (failureCode: string | null): string => {
  switch (failureCode) {
    case 'scope_limit':
      return 'too many research briefs are open at once'
    case 'scope_rejected':
    case 'start_rejected':
      return 'DeepWater could not accept the research brief'
    case 'identity_unavailable':
      return 'your sign-in could not be confirmed'
    case 'start_timeout':
      return 'DeepWater did not start the research'
    case 'start_unconfirmed':
      return 'DeepWater did not confirm the research brief'
    case 'start_identity_changed':
      return 'your sign-in changed before the research brief could be opened'
    case 'timed_out':
      return 'the research stopped making progress'
    default:
      return 'DeepWater stopped before the research finished'
  }
}

const sentence = (clause: string): string => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`

/** The same reason as a sentence of its own, for a view's `failure.message`. */
export const deepWaterFailureSentence = (failureCode: string | null): string =>
  sentence(deepWaterFailureMessage(failureCode))

/** A run an operator has to finish setting up (`needs_setup`). */
export const DEEP_WATER_NEEDS_OPERATOR_MESSAGE = 'This research is waiting for DeepWater to finish setting it up.'

/**
 * Why the planner could not answer a turn (`plannerTurn.failed.message`), from
 * the turn's error code. Whether the person can send it again is the view's
 * `retryable`, never a promise in these words.
 */
export const deepWaterPlannerFailureMessage = (errorCode: string | null): string => {
  switch (errorCode) {
    case 'compute_refused':
      return 'DeepWater could not start its research planner for this message.'
    case 'planner_interrupted':
      return 'DeepWater\'s research planner was interrupted before it finished answering.'
    case 'planner_stalled':
      return 'DeepWater\'s research planner stopped responding before it answered.'
    case 'turn_lost':
      return 'The answer from DeepWater\'s research planner did not come back.'
    case 'turn_rejected':
      return 'DeepWater could not accept that message for its research planner.'
    case 'job_terminal':
    case 'cancelled':
      return 'This research brief was closed before the planner answered.'
    default:
      return 'DeepWater\'s research planner couldn\'t answer.'
  }
}

const PENDING_ACTION_ERROR: Record<DeepWaterPendingActionErrorCode, string> = {
  busy: 'DeepWater\'s research planner is still answering. Try again once it has replied.',
  revision_conflict: 'The brief changed while you were editing it. Check the latest version, then try again.',
  not_ready: 'DeepWater isn\'t ready for your team right now.',
  brief_limit: 'You have too many research briefs open. Start or cancel one, then try again.',
  message_limit: 'This brief has reached its message limit. Start the research, or open a new brief.',
  budget_exceeded: 'Your organisation doesn\'t have enough credit left for this research.',
  forbidden: 'You can\'t do that on this research brief.',
  identity_required: 'Sign in again to continue this brief.',
  not_drafting: 'This brief has already been started or closed.',
  rejected: 'DeepWater couldn\'t accept that request.',
  unavailable: 'DeepWater couldn\'t be reached. Try again in a moment.',
}

/** Why a person's last action on a brief did not go through (`pendingAction.error.message`). */
export const deepWaterPendingActionErrorMessage = (code: DeepWaterPendingActionErrorCode): string =>
  PENDING_ACTION_ERROR[code]

const CANCEL_FAILURE: Partial<Record<DeepWaterPendingActionErrorCode, string>> = {
  unavailable: 'DeepWater couldn\'t be reached, so this research wasn\'t cancelled. Try again in a few minutes.',
  identity_required: 'Your sign-in couldn\'t be confirmed, so this research wasn\'t cancelled. Sign in again, then try again.',
  not_ready: 'DeepWater isn\'t ready for this team right now, so this research wasn\'t cancelled.',
  forbidden: 'DeepWater didn\'t accept this cancel, so the research is still open.',
}

/**
 * Why a cancel of a research that is still open did not go through
 * (`cancelFailure.message`): whoever cancelled reads it on the run.
 */
export const deepWaterCancelFailureMessage = (code: DeepWaterPendingActionErrorCode): string =>
  CANCEL_FAILURE[code] ?? 'DeepWater couldn\'t cancel this research, so it\'s still open. Try again.'
