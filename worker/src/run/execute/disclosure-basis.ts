import type { DestinationScopeChain } from '@nessie/memory'

/**
 * A scoped source a run consumed. `scopeType` is a `ThoughtAudienceType`
 * literal, so memories, knowledge-base spaces, and transcript turns all express
 * their provenance in one vocabulary.
 */
export type BasisScope = {
  scopeType: string
  scopeId: string
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
}

const scopeKey = (scope: BasisScope): string => `${scope.scopeType}:${scope.scopeId}`

export const createConsumedSourceSink = (): ConsumedSourceSink => {
  const seen = new Map<string, BasisScope>()

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
  }
}

/**
 * The scopes a destination surface implies by its own chain. A source at one of
 * these is not privileged *here* — everyone who can see this room can already
 * reach it — so it never enters a basis.
 */
const impliedByDestination = (destination: DestinationScopeChain): Set<string> =>
  new Set([
    `organization:${destination.organizationId}`,
    `project:${destination.projectId}`,
    `team:${destination.teamId}`,
    `channel:${destination.channelId}`,
  ])

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
): BasisScope[] => {
  const implied = impliedByDestination(destination)
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
