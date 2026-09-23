import { ApiClientError } from '@nessie/client-core'
import {
  DEEP_WATER_BRIEF_ERROR_CODES,
  DeepWaterResearchReadinessStateSchema,
} from '@nessie/schemas'
import { readinessCopy } from './research-presentation'

/**
 * What a person reads when the brief API refuses their action outright
 * (nessie.md §7.1's synchronous errors), and what the dialog does about it.
 * Errors DeepWater returns later arrive on the brief itself as
 * `pendingAction.error` with Nessie's own words, so they are not here.
 */

/** The action that was refused: a refusal's remedy depends on what was asked. */
export type BriefAction = 'create' | 'reply' | 'start' | 'cancel' | 'deliver'

export type BriefActionFailure = {
  message: string
  /**
   * The brief the dialog holds is stale: fetch it again. A revision conflict
   * then rebases the person's unsent edits onto the new brief.
   */
  refetch: boolean
  /** Sending the same thing again could succeed (a lost or failed connection). */
  retrySameAction: boolean
}

const codes = DEEP_WATER_BRIEF_ERROR_CODES

/**
 * Why DeepWater refused as not ready, in the words the readiness screen uses
 * for this viewer: a team owner is told to turn it on or update it, anyone
 * else to ask a team owner. The refusal also refetches the products list
 * (the facades' `onDeepWaterActionError`), so a dialog still holding a stale
 * "ready" verdict gives way to the readiness screen and its way forward.
 */
const readinessReason = (details: unknown, viewerIsOwner: boolean): string | null => {
  const reason = (details as { reason?: unknown } | null | undefined)?.reason
  const parsed = DeepWaterResearchReadinessStateSchema.safeParse(reason)
  return parsed.success && parsed.data !== 'ready' ? readinessCopy(parsed.data, viewerIsOwner).message : null
}

/**
 * No answer came back — the connection dropped, or the request timed out. The
 * request may still have reached Nessie and been recorded, so this never
 * says it did not; trying again reuses its key, so it is never done twice.
 */
const NO_ANSWER = 'Nessie didn’t answer. Check your connection, then try again.'

/**
 * `DEEP_WATER_BRIEF_BUSY` means something different for each action: a reply
 * or Start waits for DeepWater to finish with the last change to the brief,
 * while a cancel waits for DeepWater to finish opening the brief — before
 * then there is nothing it could name to stop.
 */
const BUSY_COPY: Record<BriefAction, string> = {
  cancel: 'DeepWater is still opening this brief, so it can’t be stopped yet. Try again in a few minutes.',
  create: 'DeepWater is busy just now. Try again in a moment.',
  deliver: 'DeepWater is busy just now. Try again in a moment.',
  reply: 'DeepWater is still working on the last change to this brief. Try again once it has answered.',
  start: 'DeepWater is still working on the last change to this brief. Try again once it has answered.',
}

/** `viewerIsOwner`: the session's owner role, which decides a not-ready refusal's remedy. */
export const briefActionFailure = (
  error: unknown,
  action: BriefAction,
  viewerIsOwner: boolean,
): BriefActionFailure => {
  if (!(error instanceof ApiClientError)) {
    return { message: NO_ANSWER, refetch: false, retrySameAction: true }
  }
  const refuse = (message: string, refetch = false): BriefActionFailure => ({
    message,
    refetch,
    retrySameAction: false,
  })
  switch (error.code) {
    case codes.BRIEF_REVISION_CONFLICT:
      // The rebase notice says what DeepWater changed; this says only what to do.
      return refuse('The brief changed just before you sent that. Check it, then try again.', true)
    case codes.BRIEF_BUSY:
      return refuse(BUSY_COPY[action], true)
    case codes.BRIEF_NOT_EDITABLE:
      return refuse('This brief can’t be changed any more.', true)
    case codes.BRIEF_INCOMPLETE:
      return refuse('Add at least one pillar before you start the research.')
    case codes.BRIEF_THREAD_FORBIDDEN:
      return refuse('You can’t post in this conversation, so research can’t be started from it.')
    case codes.TEAM_MISMATCH:
      return refuse('This conversation belongs to another team. Switch to that team to start research here.')
    case codes.NOT_READY:
      return refuse(readinessReason(error.details, viewerIsOwner) ?? 'DeepWater isn’t ready for your team right now.')
    case codes.RESEARCH_NOT_FOUND:
      return refuse('This research isn’t available to you any more.', true)
    case codes.RUN_NOT_CANCELLABLE:
      return refuse('This research can’t be cancelled now.', true)
    case codes.DELIVERY_NOT_BLOCKED:
      return refuse('This research no longer needs retrying.', true)
    case 'SECRET_INTERCEPTED':
      return refuse('That looks like it contains a password or key. Remove it, then send again.')
    case 'THREAD_NOT_FOUND':
      return refuse('This conversation isn’t available any more.')
    case 'INVALID_RESPONSE':
      // The server took the action but its answer could not be read. Sending
      // the same thing again reuses its key, so it is answered as a replay,
      // never done twice; the fresh read shows where it stands.
      return {
        message: 'Nessie took that, but its answer couldn’t be read. Here is where it stands now.',
        refetch: true,
        retrySameAction: true,
      }
    default:
      return error.status >= 500
        ? { message: 'Nessie couldn’t take that just now. Try again.', refetch: false, retrySameAction: true }
        : refuse('That couldn’t be done. Try again.', true)
  }
}

/**
 * The new-brief form's reading of a failure. A lost answer, or one that could
 * not be read, may have opened a brief the form has nothing of yet, so it is
 * not told "here is where it stands": pressing the button again reuses the key
 * — kept in the form's draft, so closing the dialog or reloading keeps it too —
 * and the same brief answers.
 */
export const newBriefFailure = (error: unknown, viewerIsOwner: boolean): BriefActionFailure => {
  const read = briefActionFailure(error, 'create', viewerIsOwner)
  if (!(error instanceof ApiClientError)) {
    return {
      ...read,
      message: 'Nessie didn’t answer. Check your connection, then press Plan with DeepWater again — if your '
        + 'brief was already opened, that same brief opens.',
    }
  }
  if (error.code !== 'INVALID_RESPONSE') return read
  return {
    message: 'Nessie opened the brief, but its answer couldn’t be read. Press Plan with DeepWater again to open it.',
    refetch: false,
    retrySameAction: true,
  }
}
