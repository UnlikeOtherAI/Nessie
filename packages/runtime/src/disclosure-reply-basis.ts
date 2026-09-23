import type { BasisScopeRow } from './disclosure-predicate.js'

/**
 * The disclosure basis a message carries into a destination: the consumed
 * sources that destination does not already imply.
 *
 * Shared by the worker (every reply a run writes) and the API (a DeepWater
 * research run's viewer predicate re-derives it against the origin thread's
 * live chain), so "what does this room already imply" has one answer. Two
 * implementations would drift, and a drift here is a leak.
 *
 * Structural: it compares scope identifiers, never message content.
 */

/**
 * The scope chain a destination surface sits on. Every channel carries a
 * complete, non-nullable chain (organisation → project → team → channel);
 * `@nessie/memory`'s `DestinationScopeChain` is the same shape.
 */
export type DisclosureDestinationChain = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
}

const scopeKey = (scope: BasisScopeRow): string => `${scope.scopeType}:${scope.scopeId}`

/** Subtract scopes already implied by a destination or another exact audience. */
export const subtractImpliedScopes = (
  consumed: readonly BasisScopeRow[],
  impliedScopes: readonly BasisScopeRow[],
): BasisScopeRow[] => {
  const implied = new Set(impliedScopes.map(scopeKey))
  const basis: BasisScopeRow[] = []
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
 * Scope type for a hosted agent mailbox. A read of stored mail stamps
 * `email:{mailboxId}` so the send gate can tell "answered from this
 * correspondence" apart from "answered from a private space and then mailed it
 * outside".
 */
export const EMAIL_SCOPE_TYPE = 'email'

export const emailMailboxScope = (mailboxId: string): BasisScopeRow => ({
  scopeId: mailboxId,
  scopeType: EMAIL_SCOPE_TYPE,
})

/**
 * The scopes a destination surface implies by its own chain and agent bindings.
 * A source at one of these is not privileged *here* — everyone who can see this
 * room can already reach it — so it never enters a basis.
 */
const impliedByDestination = (
  destination: DisclosureDestinationChain,
  boundAgentIds: readonly string[],
  /**
   * A hosted mailbox whose backing channel this destination *is*. Reading the
   * conversation an agent is answering is not privileged in the room that
   * exists to discuss it — without this, every email run would be restricted
   * relative to its own operations thread, which would suppress its live
   * stream and force an approval on every single reply.
   */
  impliedEmailMailboxId?: string | null,
): BasisScopeRow[] => [
  { scopeId: destination.organizationId, scopeType: 'organization' },
  { scopeId: destination.projectId, scopeType: 'project' },
  { scopeId: destination.teamId, scopeType: 'team' },
  { scopeId: destination.channelId, scopeType: 'channel' },
  ...boundAgentIds.map((scopeId) => ({ scopeId, scopeType: 'agent' })),
  ...(impliedEmailMailboxId
    ? [emailMailboxScope(impliedEmailMailboxId)]
    : []),
]

/**
 * The disclosure basis of a reply: the consumed sources the destination does not
 * already imply.
 *
 * Empty for the overwhelming majority of runs — an agent answering from
 * organization knowledge in an organization channel consumed nothing the room
 * lacks — and an empty basis means the reply is unrestricted and costs nothing
 * to store or evaluate.
 */
export const computeReplyBasis = (
  consumed: readonly BasisScopeRow[],
  destination: DisclosureDestinationChain,
  boundAgentIds: readonly string[],
  impliedEmailMailboxId?: string | null,
): BasisScopeRow[] =>
  subtractImpliedScopes(
    consumed,
    impliedByDestination(destination, boundAgentIds, impliedEmailMailboxId),
  )
