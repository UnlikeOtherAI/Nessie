import type { DestinationScopeChain } from '@nessie/memory'
import { z } from 'zod'

/**
 * A scoped source a run consumed. Most scope types are `ThoughtAudienceType`
 * literals; `agent` names the people who can see that agent. Memories,
 * knowledge-base spaces, and transcript turns therefore still express their
 * provenance in one set-containment vocabulary.
 */
export type BasisScope = {
  scopeType: string
  scopeId: string
}

/** The durable representation used by message, run, and peer-mailbox basis rows. */
export const BasisScopeSchema = z.object({
  scopeId: z.string().min(1),
  scopeType: z.string().min(1),
})

/** A private conversation's channel scope and the human whose words were read. */
export type PrivateConversationSource = {
  /** Absent means a legacy or otherwise untraceable private source: deny export. */
  sourceAuthorUserId: string | null
  sourceChannelId: string
}

/**
 * Per-run accumulator of scoped sources the run actually consumed.
 *
 * A sink rather than a return value because sources arrive at different moments:
 * memories at setup, knowledge-base pages mid-loop from tool handlers, and
 * transcript turns as the conversation window is admitted. It lives on the run
 * context, so it is naturally serialised with the run — the tool dispatcher is
 * shared across runs and cannot hold this.
 *
 * Additive only. Nothing removes a source once consumed, which is what makes a
 * checkpoint's basis (and a compaction note's, since compaction only folds turns
 * the sink has already seen) correct without per-turn provenance.
 */
export type ConsumedSourceSink = {
  add: (scope: BasisScope) => void
  addAll: (scopes: readonly BasisScope[]) => void
  /** Every source consumed so far, de-duplicated. Order is insertion order. */
  list: () => BasisScope[]
  size: () => number
  /** Human authors whose private conversation material entered this run. */
  privateConversationSources: () => PrivateConversationSource[]
  /** Records one human turn from a non-public conversation. */
  addPrivateConversationSource: (source: PrivateConversationSource) => void
}

const scopeKey = (scope: BasisScope): string => `${scope.scopeType}:${scope.scopeId}`

export const createConsumedSourceSink = (): ConsumedSourceSink => {
  const seen = new Map<string, BasisScope>()
  const privateConversationSources = new Map<string, PrivateConversationSource>()

  const add = (scope: BasisScope): void => {
    if (!scope.scopeType || !scope.scopeId) {
      return
    }
    const key = scopeKey(scope)
    if (!seen.has(key)) {
      seen.set(key, { scopeId: scope.scopeId, scopeType: scope.scopeType })
    }
  }

  return {
    add,
    addAll: (scopes) => {
      for (const scope of scopes) {
        add(scope)
      }
    },
    list: () => [...seen.values()],
    size: () => seen.size,
    privateConversationSources: () => [...privateConversationSources.values()],
    addPrivateConversationSource: (source) => {
      if (!source.sourceChannelId) return
      add({ scopeId: source.sourceChannelId, scopeType: 'channel' })
      const key = `${source.sourceChannelId}:${source.sourceAuthorUserId ?? 'unknown'}`
      if (!privateConversationSources.has(key)) {
        privateConversationSources.set(key, source)
      }
    },
  }
}

/** Subtract scopes already implied by a destination or another exact audience. */
export const subtractImpliedScopes = (
  consumed: readonly BasisScope[],
  impliedScopes: readonly BasisScope[],
): BasisScope[] => {
  const implied = new Set(impliedScopes.map(scopeKey))
  const basis: BasisScope[] = []
  const seen = new Set<string>()

  for (const scope of consumed) {
    const key = scopeKey(scope)
    if (implied.has(key) || seen.has(key)) {
      continue
    }
    seen.add(key)
    basis.push(scope)
  }

  return basis
}

/**
 * The scopes a destination surface implies by its own chain and agent bindings.
 * A source at one of these is not privileged *here* — everyone who can see this
 * room can already reach it — so it never enters a basis.
 */
const impliedByDestination = (
  destination: DestinationScopeChain,
  boundAgentIds: readonly string[],
  /**
   * A hosted mailbox whose backing channel this destination *is*. Reading the
   * conversation an agent is answering is not privileged in the room that
   * exists to discuss it — without this, every email run would be restricted
   * relative to its own operations thread, which would suppress its live
   * stream and force an approval on every single reply.
   */
  impliedEmailMailboxId?: string | null,
): BasisScope[] => [
  { scopeId: destination.organizationId, scopeType: 'organization' },
  { scopeId: destination.projectId, scopeType: 'project' },
  { scopeId: destination.teamId, scopeType: 'team' },
  { scopeId: destination.channelId, scopeType: 'channel' },
  ...boundAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' })),
  ...(impliedEmailMailboxId
    ? [{ scopeId: impliedEmailMailboxId, scopeType: EMAIL_SCOPE_TYPE }]
    : []),
]

/**
 * Scope type for a hosted agent mailbox. A read of stored mail stamps
 * `email:{mailboxId}` so the send gate can tell "answered from this
 * correspondence" apart from "answered from a private space and then mailed it
 * outside".
 */
export const EMAIL_SCOPE_TYPE = 'email'

export const emailMailboxScope = (mailboxId: string): BasisScope => ({
  scopeId: mailboxId,
  scopeType: EMAIL_SCOPE_TYPE,
})

/**
 * The disclosure basis of a reply: the consumed sources the destination does not
 * already imply.
 *
 * Empty for the overwhelming majority of runs — an agent answering from
 * organization knowledge in an organization channel consumed nothing the room
 * lacks — and an empty basis means the reply is unrestricted and costs nothing
 * to store or evaluate.
 *
 * Structural: it compares scope identifiers, never message content.
 */
export const computeReplyBasis = (
  consumed: readonly BasisScope[],
  destination: DestinationScopeChain,
  boundAgentIds: readonly string[],
  impliedEmailMailboxId?: string | null,
): BasisScope[] => {
  return subtractImpliedScopes(
    consumed,
    impliedByDestination(destination, boundAgentIds, impliedEmailMailboxId),
  )
}
