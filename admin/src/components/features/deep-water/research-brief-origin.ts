import type { DeepWaterBriefOriginRequest, DeepWaterResearchRunView } from '@nessie/schemas'

/**
 * Where a new brief's result comes back (Water plan nessie.md §7.1 `origin`,
 * reply-threads standard: research results reply under the card). A screen's
 * host names its own conversation; a doorway can narrow that to one of its
 * reply threads, or name the place outright — Start again restarts a research
 * where the first one was asked, and a composer over another conversation (a
 * drawer, a Threads inbox card) names that conversation. Pure, so the rule is
 * tested without a router.
 */

export type NewBriefPlace = {
  /**
   * Where the brief comes back, outright. `null` says there is nowhere yet (a
   * conversation still opening), which is not the same as leaving it unsaid.
   */
  origin?: DeepWaterBriefOriginRequest | null
  /** A reply thread of the screen's own conversation: its card and result land under this root. */
  rootMessageId?: string | null
}

/** Open a new brief with this question, coming back to this place. */
export type OpenNewBrief = (topic?: string, place?: NewBriefPlace) => void

/** Start a failed research again, with its question, where it was asked. */
export type StartAgain = (topic: string, place?: NewBriefPlace) => void

/** The origin a new brief is sent with, from the screen's own and what the doorway said. */
export const resolveBriefOrigin = (
  screen: DeepWaterBriefOriginRequest | null,
  place: NewBriefPlace | undefined,
): DeepWaterBriefOriginRequest | null => {
  if (place?.origin !== undefined) return place.origin
  if (screen?.kind === 'thread' && place?.rootMessageId) return { ...screen, rootMessageId: place.rootMessageId }
  return screen
}

/**
 * Where Start again sends a research: the conversation, thread and reply
 * thread the failed one came from. A research with no conversation left to
 * name comes back to wherever the screen's host sends new briefs.
 */
export const startAgainPlace = (run: Pick<DeepWaterResearchRunView, 'origin'>): NewBriefPlace => {
  const { channelId, rootMessageId, threadId } = run.origin
  if (!channelId || !threadId) return {}
  return {
    origin: { channelId, kind: 'thread', threadId, ...(rootMessageId ? { rootMessageId } : {}) },
  }
}
