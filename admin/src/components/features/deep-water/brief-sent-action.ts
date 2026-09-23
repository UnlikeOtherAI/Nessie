import type { DeepWaterBriefView, DeepWaterResearchRunView } from '@nessie/schemas'
import { NO_EDITS, hasLocalEdits, layerEdits, reviveBriefEdits, subtractEdits, type BriefEdits } from './brief-edits'
import { reviveHeldActionId, type HeldActionId } from './intent-action-ids'

/**
 * What a person's brief draft remembers about the action they last sent, and
 * how that action ended (amendments-fable F8, amendments N2). Pure, so every
 * ending is tested without React.
 *
 * The API answers an action with 202 before DeepWater has done anything with
 * it, so the draft forgets what was sent at once but holds it here until the
 * brief shows how it ended:
 * - **Refused** (`pendingAction.error` names it): its words and edits come
 *   back into the draft, so trying again is one tap.
 * - **The planner could not answer** a reply (`plannerTurn` failed once the
 *   action is over — Nessie clears the pending action without an error when a
 *   turn settles, and DeepWater writes no transcript row for a failed turn):
 *   its words come back into the reply box and are what Send again sends.
 *   Its edits were applied before the turn ran, so only an unmoved revision
 *   gives them back.
 * - **Anything else** (answered, launched, closed): it is simply forgotten.
 *
 * The record lives in the stored draft, so closing the dialog or reloading
 * while the planner works loses none of it. So do the keys a reply and Start
 * were last sent with while their answer is unknown (`held`): the words and
 * edits of a request whose answer was lost stay in the draft, and sending them
 * again after a reload must reuse that key (`useStoredIntentActionId`).
 */

export type SentBriefAction = {
  actionId: string
  kind: 'reply' | 'start'
  /** The words a reply sent; empty for Start. */
  message: string
  /** Those words were what the person had typed, so a failure puts them back in the box. */
  typed: boolean
  edits: BriefEdits
  /** The brief's revision the action was sent against. */
  revision: number | null
  /** The brief (or the server's answer) has shown this action in flight or already over. */
  seen: boolean
}

/** The key each kind of action was last sent with, until the server has decided it. */
export type HeldBriefActionIds = { reply: HeldActionId | null; start: HeldActionId | null }

export type BriefDraft = {
  edits: BriefEdits
  held: HeldBriefActionIds
  message: string
  sent: SentBriefAction | null
  /** The words of the reply DeepWater's planner could not answer: what Send again sends. */
  unanswered: string | null
}

export const NO_HELD_ACTION_IDS: HeldBriefActionIds = { reply: null, start: null }

export const EMPTY_BRIEF_DRAFT: BriefDraft = {
  edits: NO_EDITS, held: NO_HELD_ACTION_IDS, message: '', sent: null, unanswered: null,
}

export const isBriefDraftEmpty = (draft: BriefDraft): boolean =>
  draft.message.trim() === '' && !hasLocalEdits(draft.edits) && draft.sent === null && draft.unanswered === null
  && draft.held.reply === null && draft.held.start === null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const reviveSent = (stored: unknown): SentBriefAction | null => {
  if (!isRecord(stored)) return null
  const { actionId, kind, message, revision, seen, typed } = stored
  if (typeof actionId !== 'string' || (kind !== 'reply' && kind !== 'start')) return null
  if (typeof message !== 'string' || typeof typed !== 'boolean' || typeof seen !== 'boolean') return null
  if (revision !== null && (typeof revision !== 'number' || !Number.isInteger(revision))) return null
  return { actionId, edits: reviveBriefEdits(stored.edits), kind, message, revision, seen, typed }
}

const reviveHeld = (stored: unknown): HeldBriefActionIds =>
  isRecord(stored)
    ? { reply: reviveHeldActionId(stored.reply), start: reviveHeldActionId(stored.start) }
    : NO_HELD_ACTION_IDS

/** Storage is untrusted input: keep only the known fields, in their known shapes. */
export const reviveBriefDraft = (stored: unknown): BriefDraft | null => {
  if (!isRecord(stored)) return null
  return {
    edits: reviveBriefEdits(stored.edits),
    held: reviveHeld(stored.held),
    message: typeof stored.message === 'string' ? stored.message : '',
    sent: reviveSent(stored.sent),
    unanswered: typeof stored.unanswered === 'string' ? stored.unanswered : null,
  }
}

/**
 * Did the server's answer to the action still show it in flight? An answer
 * that shows it already over — a replay of an action that has since ended —
 * counts as having seen it, so the brief's next state decides how it ended.
 */
export const answerShowsInFlight = (
  sent: Pick<SentBriefAction, 'actionId' | 'kind'>,
  answer: DeepWaterResearchRunView | DeepWaterBriefView,
): boolean => {
  if (sent.kind === 'start') return answer.status === 'drafting' || answer.status === 'starting'
  if (!('pendingAction' in answer)) return true
  return answer.pendingAction?.actionId === sent.actionId
    || (answer.plannerTurn.status === 'replying' && answer.plannerTurn.actionId === sent.actionId)
}

/**
 * The draft once an action carrying `sent` went out: the words and edits it
 * carried leave the draft — but only while they still equal what was sent, so
 * anything changed while the action was on its way stays — and the action is
 * held until the brief says how it ended.
 */
export const draftAfterSend = (draft: BriefDraft, sent: SentBriefAction): BriefDraft => ({
  edits: subtractEdits(draft.edits, sent.edits),
  held: draft.held,
  message: sent.typed && draft.message.trim() === sent.message ? '' : draft.message,
  sent,
  // A new reply is a new attempt; Start does not answer the planner.
  unanswered: sent.kind === 'reply' ? null : draft.unanswered,
})

type BriefProgress = Pick<DeepWaterBriefView, 'pendingAction' | 'plannerTurn' | 'revision' | 'status'>

const backInTheBox = (draft: BriefDraft, sent: SentBriefAction): string =>
  sent.typed && draft.message.trim() === '' ? sent.message : draft.message

/**
 * The draft once the brief has said how the held action ended, or null while
 * it has not (nothing to change). Called with every brief the dialog sees.
 */
export const settleSentAction = (draft: BriefDraft, brief: BriefProgress): BriefDraft | null => {
  const sent = draft.sent
  if (!sent) {
    // Send again's words are good only while the planner's failure stands.
    return draft.unanswered !== null && brief.plannerTurn.status !== 'failed' ? { ...draft, unanswered: null } : null
  }
  const pending = brief.pendingAction
  const ours = pending !== null && pending.actionId === sent.actionId
  if (ours && pending.error !== null) {
    return { ...draft, edits: layerEdits(sent.edits, draft.edits), message: backInTheBox(draft, sent), sent: null }
  }
  const inFlight = ours
    || (sent.kind === 'reply' && brief.plannerTurn.status === 'replying' && brief.plannerTurn.actionId === sent.actionId)
    || (sent.kind === 'start' && brief.status === 'starting')
  if (inFlight) return sent.seen ? null : { ...draft, sent: { ...sent, seen: true } }

  // Not in flight. Until the brief has shown it, a brief that has not moved
  // may simply be older than the action; one that has moved on is past it.
  const over = sent.seen
    || brief.revision !== sent.revision
    || pending !== null
    || (brief.status !== 'drafting' && brief.status !== 'starting')
  if (!over) return null
  if (sent.kind === 'reply' && brief.plannerTurn.status === 'failed') {
    const editsApplied = brief.revision !== sent.revision
    return {
      edits: editsApplied ? draft.edits : layerEdits(sent.edits, draft.edits),
      held: draft.held,
      message: backInTheBox(draft, sent),
      sent: null,
      unanswered: sent.message,
    }
  }
  return { ...draft, sent: null }
}

/**
 * What Send again sends after the planner could not answer: the words of the
 * reply it failed on. With no record of them — the reply was sent from another
 * device — the question is resent only when no turn has been answered yet, so
 * the failed turn was the one that opened the brief; otherwise nothing is
 * guessed and the person writes their reply again.
 */
export const sendAgainMessage = (
  unanswered: string | null,
  brief: Pick<DeepWaterBriefView, 'messages' | 'topic'>,
): string | null => {
  if (unanswered !== null) return unanswered
  const answered = brief.messages.some((message) => message.author.kind === 'person' || message.author.kind === 'agent')
  return answered ? null : brief.topic
}
