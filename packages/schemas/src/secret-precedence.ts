/**
 * One secret name, resolved down the scope chain — with locks.
 *
 * The rule is the one `@nessie/runtime` `scoped-settings.ts` already states for
 * settings, and it is deliberately the same sentence: **walk from the
 * organisation down, take the most specific secret, and stop at the first
 * level marked `locked`.** A lock is how a level says "this is the credential
 * for everyone below"; because the locking level comes back with the answer, a
 * surface can grey the row out and name who decided instead of offering an
 * override the API will refuse.
 *
 * It lives in `@nessie/schemas` rather than beside either caller because both
 * ends need the identical answer: the admin renders it in the Precedence
 * column, and `POST /api/secrets` refuses a narrower write that a lock above
 * has already settled. Two implementations of one cascade is the defect the
 * settings standard was written after
 * ([docs/standards/scoped-settings.md](../../../docs/standards/scoped-settings.md)).
 *
 * Scope order is the product's containment tree, Organisation → Team →
 * Project → Channel ([docs/standards/team-model.md](../../../docs/standards/team-model.md)),
 * **not** the `Team.projectId` foreign key, which that standard records as
 * pointing the wrong way.
 */

/** Broadest first. Resolution walks this array; nothing else defines the order. */
export const SECRET_SCOPE_ORDER = ['organization', 'team', 'project', 'personal'] as const

export type SecretScopeType = (typeof SECRET_SCOPE_ORDER)[number]

/** The viewer's own chain. A scope id that does not match here is not their business. */
export type SecretPrecedenceContext = {
  userId: string
  teamId: string
  projectId: string
}

/** The fields resolution reads. Both callers pass wider rows than this. */
export type SecretPrecedenceInput = {
  locked: boolean
  name: string
  reference: string
  scopeId: string
  scopeType: SecretScopeType
  status: 'active' | 'revoked' | 'expired'
}

export type SecretScopeRef = {
  reference: string
  scopeType: SecretScopeType
}

export type SecretPrecedence = {
  /** Whether this row is the credential that actually applies for its name. */
  isEffective: boolean
  /**
   * The row that wins instead, when a *narrower* scope simply set its own.
   * Null when this row wins, when a lock is the reason (see `lockedBy`), or
   * when the row is not in the viewer's chain at all.
   */
  overriddenBy: SecretScopeRef | null
  /**
   * The strictly broader level that locked this name, when one did. A row
   * carrying this can never apply and can never be overridden — it is what the
   * table greys out, and what `POST /api/secrets` refuses to create.
   */
  lockedBy: SecretScopeRef | null
}

export type SecretWithPrecedence<T extends SecretPrecedenceInput> = T & SecretPrecedence

const scopeRank = (scope: SecretScopeType): number => SECRET_SCOPE_ORDER.indexOf(scope)

/** Whether a secret's scope resolves to the viewer's own org/team/project/personal context. */
export const isInSecretChain = (
  secret: Pick<SecretPrecedenceInput, 'scopeId' | 'scopeType'>,
  context: SecretPrecedenceContext,
): boolean => {
  switch (secret.scopeType) {
    case 'personal':
      return secret.scopeId === context.userId
    case 'team':
      return secret.scopeId === context.teamId
    case 'project':
      return secret.scopeId === context.projectId
    case 'organization':
      // Every row the API returns is already this organisation's.
      return true
  }
}

export type SecretChainResolution = {
  /** The secret in force for this name, or null when no level set one. */
  winner: SecretPrecedenceInput | null
  /** The level that stopped the walk, or null when nothing is locked. */
  lockedAtScope: SecretScopeType | null
}

/**
 * Resolve one name down a single chain. `candidates` may hold anything — rows
 * outside the chain, revoked rows, several names — because every caller has a
 * flat list and filtering twice is how the two ends drift apart.
 */
export const resolveSecretChain = (
  name: string,
  candidates: readonly SecretPrecedenceInput[],
  context: SecretPrecedenceContext,
): SecretChainResolution => {
  const byScope = new Map<SecretScopeType, SecretPrecedenceInput>()
  for (const candidate of candidates) {
    if (candidate.name !== name) continue
    if (candidate.status !== 'active') continue
    if (!isInSecretChain(candidate, context)) continue
    // A scope holds at most one active secret per name — the `Secret` table's
    // own `@@unique([organizationId, scopeType, scopeId, name])` — so the
    // first row for a scope is the only one.
    if (!byScope.has(candidate.scopeType)) byScope.set(candidate.scopeType, candidate)
  }

  let winner: SecretPrecedenceInput | null = null
  for (const scope of SECRET_SCOPE_ORDER) {
    const candidate = byScope.get(scope)
    if (!candidate) continue
    winner = candidate
    if (candidate.locked) return { lockedAtScope: scope, winner }
  }
  return { lockedAtScope: null, winner }
}

/**
 * Annotate every row with whether it applies, and — when it does not — whether
 * a narrower scope overrode it or a broader one locked it.
 *
 * A revoked or expired row never participates: it is neither effective nor
 * overridden, because there is nothing live about it to name. It still renders,
 * in its own tab.
 */
export const computeSecretPrecedence = <T extends SecretPrecedenceInput>(
  secrets: readonly T[],
  context: SecretPrecedenceContext,
): SecretWithPrecedence<T>[] => {
  const resolutions = new Map<string, SecretChainResolution>()
  const resolutionFor = (name: string): SecretChainResolution => {
    const cached = resolutions.get(name)
    if (cached) return cached
    const resolved = resolveSecretChain(name, secrets, context)
    resolutions.set(name, resolved)
    return resolved
  }

  return secrets.map((secret) => {
    if (secret.status !== 'active' || !isInSecretChain(secret, context)) {
      return { ...secret, isEffective: false, lockedBy: null, overriddenBy: null }
    }
    const { lockedAtScope, winner } = resolutionFor(secret.name)
    if (winner?.reference === secret.reference) {
      return { ...secret, isEffective: true, lockedBy: null, overriddenBy: null }
    }
    // Strictly above: a level never locks itself out, so the row that carries
    // the lock is the winner and lands in the branch above.
    const lockedAbove = lockedAtScope !== null && scopeRank(lockedAtScope) < scopeRank(secret.scopeType)
    if (lockedAbove && winner) {
      return {
        ...secret,
        isEffective: false,
        lockedBy: { reference: winner.reference, scopeType: lockedAtScope },
        overriddenBy: null,
      }
    }
    return {
      ...secret,
      isEffective: false,
      lockedBy: null,
      overriddenBy: winner ? { reference: winner.reference, scopeType: winner.scopeType } : null,
    }
  })
}

/**
 * The write-side question: may a secret called `name` be created at
 * `scopeType`, given the locks already in force above it?
 *
 * `candidates` is every secret that could lock this write — for a personal
 * write that is the organisation plus **every** team and project the person
 * belongs to, not only their active one, because a lock binds the whole subtree
 * beneath it and a person is in many teams. The caller loads that set; this
 * decides.
 */
export const findSecretLockAbove = (
  input: {
    name: string
    scopeType: SecretScopeType
  },
  candidates: readonly SecretPrecedenceInput[],
): SecretPrecedenceInput | null => {
  const rank = scopeRank(input.scopeType)
  let broadest: SecretPrecedenceInput | null = null
  for (const candidate of candidates) {
    if (!candidate.locked) continue
    if (candidate.status !== 'active') continue
    if (candidate.name !== input.name) continue
    if (scopeRank(candidate.scopeType) >= rank) continue
    if (!broadest || scopeRank(candidate.scopeType) < scopeRank(broadest.scopeType)) {
      broadest = candidate
    }
  }
  return broadest
}
