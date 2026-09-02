/**
 * Which conversation an inbound message joins.
 *
 * `In-Reply-To` first, then `References` newest-first, matched against message
 * ids this mailbox has actually seen. Everything here degrades safely: a
 * missing, malformed, duplicated or forged `Message-ID` produces a *new*
 * conversation, never a dropped message and never a merge into someone else's
 * thread. That is why the id is an index and not a uniqueness constraint — the
 * value is written by the sender.
 *
 * The candidate set the caller supplies is already scoped to one mailbox, so a
 * crafted `References` header naming another tenant's id matches nothing.
 */

export type ThreadingCandidate = {
  conversationId: string
  rfcMessageId: string
}

export type ThreadingDecision =
  | { kind: 'existing'; conversationId: string; matchedOn: 'in_reply_to' | 'references' }
  | { kind: 'new' }

export const resolveInboundThreading = (input: {
  inReplyTo: string | null
  /** Oldest → newest, as the header carries them. */
  references: readonly string[]
  candidates: readonly ThreadingCandidate[]
}): ThreadingDecision => {
  if (input.candidates.length === 0) return { kind: 'new' }

  const byMessageId = new Map<string, string>()
  for (const candidate of input.candidates) {
    // First writer wins: if two messages in this mailbox somehow share an id,
    // the older conversation keeps the thread rather than the newer stealing it.
    if (!byMessageId.has(candidate.rfcMessageId)) {
      byMessageId.set(candidate.rfcMessageId, candidate.conversationId)
    }
  }

  if (input.inReplyTo) {
    const direct = byMessageId.get(input.inReplyTo)
    if (direct) return { conversationId: direct, kind: 'existing', matchedOn: 'in_reply_to' }
  }

  // Newest first: the nearest ancestor we recognise is the most specific.
  for (let index = input.references.length - 1; index >= 0; index -= 1) {
    const referenceId = input.references[index]
    if (!referenceId) continue
    const match = byMessageId.get(referenceId)
    if (match) return { conversationId: match, kind: 'existing', matchedOn: 'references' }
  }

  return { kind: 'new' }
}
