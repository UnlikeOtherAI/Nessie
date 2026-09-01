// Ambient liveness hint: the one quiet line that covers the gap between "you
// sent it" and the first durable signal a run produces (`stream.start`, which
// only fires after queue pickup, the engagement-decision call, a second queue
// hop, run claim, toolset assembly and memory retrieval).
//
// It is deliberately ANONYMOUS. The engagement decision is model-judged and may
// decline, so naming an agent before a durable Run exists would promise a reply
// the system may never send. An unnamed "something is happening" may appear and
// quietly fade; a named one may not.
//
// React-free on purpose so both the clear-conditions and the surface's reading
// of them are unit-testable.

import type { ThreadMessageRecord } from '../../../lib/api-client'

// How long an unanswered hint stays up. Long enough to cover queue pickup plus
// an engagement-decision call on a slow day; short enough that a declined
// engagement (or a failed enqueue) leaves nothing pulsing on screen.
export const LIVENESS_HINT_TIMEOUT_MS = 10_000

/**
 * The structural facts that say something happened on this surface after the
 * viewer posted. No message content is interpreted — only authorship and who
 * placed a reaction.
 */
export type LivenessSignature = {
  // Agent-placed reactions across the surface. The engagement orchestrator's
  // `acknowledge` decision puts one on the trigger message *instead* of
  // replying, which is a complete answer to "is anything going to happen?".
  agentReactionCount: number
  // Newest message on this surface not authored by the viewer — an agent's
  // reply, or another person's. The viewer's own message coming back from the
  // server deliberately does not count: that is the send completing, not a
  // response to it.
  foreignMessageId: string | null
}

export const readLivenessSignature = (
  messages: ThreadMessageRecord[],
  meUserId: string,
): LivenessSignature => {
  let agentReactionCount = 0
  let foreignMessageId: string | null = null

  for (const message of messages) {
    if (message.userId !== meUserId) {
      foreignMessageId = message.id
    }
    for (const reaction of message.reactions ?? []) {
      if (reaction.agentId) {
        agentReactionCount += 1
      }
    }
  }

  return { agentReactionCount, foreignMessageId }
}

/**
 * Is the ambient hint on screen right now?
 *
 * Derived at render rather than cleared from an effect, so the dots and a
 * thinking bubble can never be painted in the same frame: the instant a run
 * announces itself, the bubble IS the indicator and this returns false.
 *
 * `baseline` is the signature captured when the viewer sent; `null` means there
 * is nothing to wait for (never sent, already resolved, or timed out).
 */
export const shouldShowLivenessHint = (input: {
  baseline: LivenessSignature | null
  current: LivenessSignature
  hasPendingRun: boolean
}): boolean => {
  if (!input.baseline || input.hasPendingRun) {
    return false
  }

  return (
    input.current.foreignMessageId === input.baseline.foreignMessageId &&
    input.current.agentReactionCount === input.baseline.agentReactionCount
  )
}
