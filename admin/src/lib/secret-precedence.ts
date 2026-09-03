import type { SecretRecord } from '../facades/secrets/hooks'

/**
 * A secret's scope override tree: `personal` (the viewer's own) beats
 * `project` beats `team` beats `organization` — the same containment order
 * as Organisation → Team → Project → Channel
 * (docs/standards/team-model.md). Two secrets only stand in an override
 * relationship when they share a `name` AND both scopes resolve to the
 * viewer's OWN current context — a team-scoped secret in some other team the
 * viewer merely happens to be able to see (as an owner) never overrides or is
 * overridden by anything here, because it is not part of any single
 * resolution chain the viewer is actually subject to.
 */
const SCOPE_RANK: Record<SecretRecord['scopeType'], number> = {
  personal: 3,
  project: 2,
  team: 1,
  organization: 0,
}

export type SecretPrecedenceContext = {
  userId: string
  teamId: string
  projectId: string
}

export type SecretWithPrecedence = SecretRecord & {
  /** Whether this row currently wins for its `name` inside the viewer's own chain. */
  isEffective: boolean
  /** The row that overrides this one, when it does not win. */
  overriddenBy: { scopeType: SecretRecord['scopeType']; reference: string } | null
}

/** Whether `secret`'s scope resolves to the viewer's own personal/team/project/org context. */
const isInViewerChain = (secret: SecretRecord, context: SecretPrecedenceContext): boolean => {
  switch (secret.scopeType) {
    case 'personal':
      return secret.scopeId === context.userId
    case 'team':
      return secret.scopeId === context.teamId
    case 'project':
      return secret.scopeId === context.projectId
    case 'organization':
      return true
  }
}

/**
 * Annotate each secret with whether it is the one that would actually apply
 * for its `name` in the viewer's own org/team/project/personal context, and
 * — when it does not win — which secret overrides it. Only `active` secrets
 * participate in the resolution; a `revoked`/`expired` row is never
 * effective and never overrides anything, but still renders in its own row
 * with `isEffective: false, overriddenBy: null` (there is nothing live to
 * name as the overrider).
 */
export const computeSecretPrecedence = (
  secrets: readonly SecretRecord[],
  context: SecretPrecedenceContext,
): SecretWithPrecedence[] => {
  const winnerByName = new Map<string, SecretRecord>()
  for (const secret of secrets) {
    if (secret.status !== 'active' || !isInViewerChain(secret, context)) continue
    const current = winnerByName.get(secret.name)
    if (!current || SCOPE_RANK[secret.scopeType] > SCOPE_RANK[current.scopeType]) {
      winnerByName.set(secret.name, secret)
    }
  }

  return secrets.map((secret) => {
    const winner = winnerByName.get(secret.name)
    const isEffective = winner?.reference === secret.reference
    return {
      ...secret,
      isEffective,
      overriddenBy: !isEffective && winner && secret.status === 'active' && isInViewerChain(secret, context)
        ? { scopeType: winner.scopeType, reference: winner.reference }
        : null,
    }
  })
}
