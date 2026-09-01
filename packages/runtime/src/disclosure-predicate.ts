/**
 * The disclosure read predicate, shared by the API and the worker so a message
 * withheld from a conversation window is the same message withheld from the
 * admin feed. Two implementations would drift, and a drift here is a leak.
 *
 * A message is visible to a viewer when **either**:
 *   - it carries no basis rows at all (the overwhelming majority — unrestricted,
 *     including every message written before this feature existed), or
 *   - the viewer satisfies **every** basis scope on it.
 *
 * Containment, not intersection: overlapping on one scope is not enough. The
 * organization audience is in almost every viewer's scope set, so an
 * intersection test would admit everyone and close nothing.
 */

export type BasisScopeRow = {
  scopeType: string
  scopeId: string
}

/**
 * What a viewer can reach, as (type, id) pairs — the same vocabulary a basis is
 * written in. `null` means "no viewer": an autonomous run or an unauthenticated
 * reader, which may see only unrestricted content.
 */
export type DisclosureViewer =
  | { kind: 'user'; userId: string; scopes: readonly BasisScopeRow[] }
  | { kind: 'autonomous' }

const scopeKey = (scope: BasisScopeRow): string => `${scope.scopeType}:${scope.scopeId}`

/**
 * Does this viewer satisfy every scope in the basis?
 *
 * `grantedScopeKeys` carries scopes admitted by an active disclosure grant (a
 * nod, or a standing scope grant) rather than by membership — evaluated at read
 * time, which is what makes revocation immediate and free of propagation.
 */
export const viewerSatisfiesBasis = (
  basis: readonly BasisScopeRow[],
  viewer: DisclosureViewer,
  grantedScopeKeys: ReadonlySet<string> = new Set(),
): boolean => {
  if (basis.length === 0) {
    return true
  }
  if (viewer.kind === 'autonomous') {
    return false
  }

  const reachable = new Set(viewer.scopes.map(scopeKey))
  return basis.every((scope) => {
    const key = scopeKey(scope)
    return reachable.has(key) || grantedScopeKeys.has(key)
  })
}

export type BasisCarryingMessage = {
  basisScopes?: readonly BasisScopeRow[] | null
}

/**
 * Partition messages into what the viewer may read and what must be withheld.
 *
 * Withheld messages are returned rather than dropped so callers can render a
 * placeholder. A silent omission is worse than a visible gap: the model invents
 * continuity across a hole it cannot see, and a human reading the feed cannot
 * tell whether the conversation jumped or the product broke.
 */
export const partitionByDisclosure = <T extends BasisCarryingMessage>(
  messages: readonly T[],
  viewer: DisclosureViewer,
  grantedScopeKeys: ReadonlySet<string> = new Set(),
): { visible: T[]; withheld: T[] } => {
  const visible: T[] = []
  const withheld: T[] = []

  for (const message of messages) {
    if (viewerSatisfiesBasis(message.basisScopes ?? [], viewer, grantedScopeKeys)) {
      visible.push(message)
    } else {
      withheld.push(message)
    }
  }

  return { visible, withheld }
}

/**
 * The fail-closed form, for readers that cannot render a placeholder and must
 * not leak — message search being the case that matters. Search returns content
 * snippets scoped by channel membership alone, so until it is entitlement-aware
 * it simply excludes anything carrying a basis at all.
 */
export const isUnrestricted = (message: BasisCarryingMessage): boolean =>
  (message.basisScopes ?? []).length === 0

/**
 * Server-authored placeholder text for a withheld turn. Constant and
 * server-side: never derived from the withheld content, and never model-written.
 */
export const WITHHELD_MESSAGE_PLACEHOLDER =
  '[An earlier reply in this thread is not available to you — '
  + 'it drew on sources you do not have access to.]'
