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

const readinessReason = (details: unknown): string | null => {
  const reason = (details as { reason?: unknown } | null | undefined)?.reason
  const parsed = DeepWaterResearchReadinessStateSchema.safeParse(reason)
  return parsed.success && parsed.data !== 'ready' ? readinessCopy(parsed.data, false).message : null
}

export const briefActionFailure = (error: unknown): BriefActionFailure => {
  if (!(error instanceof ApiClientError)) {
    return {
      message: 'That didn’t reach Nessie. Check your connection, then try again.',
      refetch: false,
      retrySameAction: true,
    }
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
      return refuse('DeepWater’s research planner is still answering. Try again once it has replied.', true)
    case codes.BRIEF_NOT_EDITABLE:
      return refuse('This brief can’t be changed any more.', true)
    case codes.BRIEF_INCOMPLETE:
      return refuse('Add at least one pillar before you start the research.')
    case codes.BRIEF_THREAD_FORBIDDEN:
      return refuse('You can’t post in this conversation, so research can’t be started from it.')
    case codes.TEAM_MISMATCH:
      return refuse('This conversation belongs to another team. Switch to that team to start research here.')
    case codes.NOT_READY:
      return refuse(readinessReason(error.details) ?? 'DeepWater isn’t ready for your team right now.')
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
    default:
      return error.status >= 500
        ? { message: 'Nessie couldn’t take that just now. Try again.', refetch: false, retrySameAction: true }
        : refuse('That couldn’t be done. Try again.', true)
  }
}
