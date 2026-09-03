import { Prisma } from '@prisma/client'
import type {
  ModelSubscription,
  ModelSubscriptionHealthReason,
  PrismaClient,
} from '@prisma/client'
import { requireSubscriptionAdapter } from './adapters.js'
import type { SubscriptionSecretStore } from './secret-store.js'
import {
  ModelSubscriptionError,
  SUBSCRIPTION_ERROR_CODES,
  type SubscriptionAccountIdentity,
  type SubscriptionCredentialBundle,
  type SubscriptionFailureKind,
  type SubscriptionProviderAdapter,
} from './types.js'

/**
 * The one place a subscription credential is read, rotated, or retired.
 *
 * Serialization is the whole point. OpenClaw's field lesson (their
 * `docs/concepts/oauth.md`, "the token sink") is that providers rotate refresh
 * tokens and invalidate the previous one, so two writers on one grant log each
 * other out. Nessie's single writer is the server behind a row-scoped lock —
 * but the lock is a SHORT CLAIM, not a transaction held open across a provider
 * call: holding a Postgres transaction through a slow network round trip is
 * how the comms coordinator ended up with a lock that outlives its usefulness.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.2, §2.5.
 */

/** Refresh this far before expiry rather than waiting for a 401. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * How long a refresh claim stays valid before another process may reclaim it.
 * Longer than any single provider call, so a live refresh is never stolen
 * mid-flight; short enough that a crashed process does not park a link.
 */
export const REFRESH_CLAIM_LEASE_MS = 120 * 1000

export type ResolvedSubscriptionCredential = {
  accessToken: string
  /** Adapter-declared transport headers; never caller- or model-supplied. */
  extraHeaders?: Record<string, string>
  /** The generation this token belongs to. Carried into dispatch so a delayed
   *  failure can be matched against the credential that actually failed. */
  epoch: number
  subscriptionId: string
  providerKey: string
  baseUrl: string
  runtimeProvider: SubscriptionProviderAdapter['transport']['runtimeProvider']
}

export type SubscriptionCoordinatorDeps = {
  prisma: PrismaClient
  secretStore: SubscriptionSecretStore | null
  now?: () => Date
}

const requireStore = (deps: SubscriptionCoordinatorDeps): SubscriptionSecretStore => {
  if (!deps.secretStore) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE,
      'Personal subscriptions are not available on this deployment.',
      'The credential vault is not configured.',
    )
  }
  return deps.secretStore
}

const nowOf = (deps: SubscriptionCoordinatorDeps): Date => deps.now?.() ?? new Date()

/**
 * The vault secret name for a link. Derived from the subscription id, so it is
 * stable across rotations, unguessable from a user id alone, and recoverable
 * for cleanup after the row is gone.
 */
export const subscriptionSecretName = (subscriptionId: string): string =>
  `model-subscription-${subscriptionId}`

/**
 * Load a subscription and prove it may be spent right now.
 *
 * The composite FK proves the owner's membership row EXISTS; it never proves
 * the membership is live, so liveness is re-derived here on every read — the
 * same discipline `buildVisibleAgentWhere` applies to agent ownership.
 */
export const loadSpendableSubscription = async (
  deps: SubscriptionCoordinatorDeps,
  input: { subscriptionId: string; organizationId: string; expectedOwnerUserId?: string },
): Promise<ModelSubscription> => {
  const subscription = await deps.prisma.modelSubscription.findFirst({
    where: { id: input.subscriptionId, organizationId: input.organizationId },
  })
  if (!subscription) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
      'That personal subscription is no longer linked.',
    )
  }
  if (
    input.expectedOwnerUserId !== undefined
    && subscription.userId !== input.expectedOwnerUserId
  ) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
      'That personal subscription is no longer linked.',
    )
  }
  if (subscription.status !== 'active') {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_ACTIVE,
      subscription.status === 'needs_reauthorization'
        ? 'That personal subscription needs to be reconnected.'
        : 'That personal subscription is not active.',
    )
  }
  const membership = await deps.prisma.organizationMember.findUnique({
    select: { deactivatedAt: true },
    where: {
      organizationId_userId: {
        organizationId: subscription.organizationId,
        userId: subscription.userId,
      },
    },
  })
  if (!membership || membership.deactivatedAt !== null) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.OWNER_INACTIVE,
      'The person who owns this subscription is no longer active in this team.',
    )
  }
  return subscription
}

/**
 * Claim the right to refresh. One conditional UPDATE carrying the decision, so
 * two replicas cannot both spend a one-shot refresh token: the loser sees zero
 * rows updated and waits for the winner's result instead of racing it.
 */
const claimRefresh = async (
  deps: SubscriptionCoordinatorDeps,
  input: { subscriptionId: string; epoch: number },
): Promise<boolean> => {
  const now = nowOf(deps)
  const leaseFloor = new Date(now.getTime() - REFRESH_CLAIM_LEASE_MS)
  const claimed = await deps.prisma.modelSubscription.updateMany({
    data: { refreshClaimedAt: now },
    where: {
      OR: [{ refreshClaimedAt: null }, { refreshClaimedAt: { lt: leaseFloor } }],
      credentialEpoch: input.epoch,
      id: input.subscriptionId,
    },
  })
  return claimed.count === 1
}

const releaseRefreshClaim = async (
  deps: SubscriptionCoordinatorDeps,
  subscriptionId: string,
): Promise<void> => {
  await deps.prisma.modelSubscription
    .updateMany({ data: { refreshClaimedAt: null }, where: { id: subscriptionId } })
    .catch(() => undefined)
}

const shouldRefresh = (
  bundle: SubscriptionCredentialBundle,
  adapter: SubscriptionProviderAdapter,
  now: Date,
): boolean => {
  if (!adapter.refresh || !bundle.refreshToken) return false
  if (bundle.expiresAt === undefined) return false
  return bundle.expiresAt - now.getTime() <= REFRESH_MARGIN_MS
}

/**
 * Rotate the credential, then publish it: vault first, metadata second.
 *
 * The order matters. A crash between them leaves the vault holding the NEW
 * bundle and the row holding the old epoch, which the next read simply picks
 * up. The reverse order would leave a row advertising a generation the vault
 * does not have.
 */
const performRefresh = async (
  deps: SubscriptionCoordinatorDeps,
  input: {
    adapter: SubscriptionProviderAdapter
    bundle: SubscriptionCredentialBundle
    subscription: ModelSubscription
  },
): Promise<SubscriptionCredentialBundle> => {
  const store = requireStore(deps)
  const refresh = input.adapter.refresh
  if (!refresh) return input.bundle

  let next: SubscriptionCredentialBundle
  try {
    next = await refresh(input.bundle)
  } catch (error) {
    // A refresh grant is NEVER retried on a transport failure: the provider may
    // already have consumed and rotated the token, and a resend would burn the
    // family. Park it for explicit recovery instead.
    await releaseRefreshClaim(deps, input.subscription.id)
    if (error instanceof ModelSubscriptionError) throw error
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.REFRESH_INDETERMINATE,
      'This subscription could not be refreshed and needs to be reconnected.',
      error instanceof Error ? error.message : undefined,
    )
  }

  await store.write({
    bundle: next,
    name: subscriptionSecretName(input.subscription.id),
  })
  await deps.prisma.modelSubscription.updateMany({
    data: { credentialEpoch: { increment: 1 }, refreshClaimedAt: null },
    where: { credentialEpoch: input.subscription.credentialEpoch, id: input.subscription.id },
  })
  await deps.prisma.modelSubscriptionCredential.updateMany({
    data: { expiresAt: next.expiresAt === undefined ? null : new Date(next.expiresAt) },
    where: { subscriptionId: input.subscription.id },
  })
  return next
}

/**
 * Resolve a usable access token for a subscription, refreshing first when the
 * credential is close to expiry. This is the only path dispatch may take.
 */
export const resolveSubscriptionCredential = async (
  deps: SubscriptionCoordinatorDeps,
  input: { subscriptionId: string; organizationId: string; expectedOwnerUserId?: string },
): Promise<ResolvedSubscriptionCredential> => {
  const store = requireStore(deps)
  const subscription = await loadSpendableSubscription(deps, input)
  const adapter = requireSubscriptionAdapter(subscription.provider)
  const credential = await deps.prisma.modelSubscriptionCredential.findUnique({
    where: { subscriptionId: subscription.id },
  })
  if (!credential) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.CREDENTIAL_MISSING,
      'That personal subscription needs to be reconnected.',
    )
  }

  let bundle = await store.read(credential.vaultSecretName)
  let epoch = subscription.credentialEpoch

  if (shouldRefresh(bundle, adapter, nowOf(deps))) {
    const claimed = await claimRefresh(deps, {
      epoch: subscription.credentialEpoch,
      subscriptionId: subscription.id,
    })
    if (claimed) {
      bundle = await performRefresh(deps, { adapter, bundle, subscription })
      epoch = subscription.credentialEpoch + 1
    } else {
      // Another writer is rotating, or already has. Re-read and adopt its
      // result rather than spending our own refresh token on the same family.
      const fresh = await deps.prisma.modelSubscription.findUnique({
        select: { credentialEpoch: true },
        where: { id: subscription.id },
      })
      bundle = await store.read(credential.vaultSecretName)
      epoch = fresh?.credentialEpoch ?? epoch
    }
  }

  const extraHeaders = adapter.transportHeaders?.(bundle)
  return {
    accessToken: bundle.accessToken,
    baseUrl: adapter.transport.baseUrl,
    epoch,
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    providerKey: adapter.key,
    runtimeProvider: adapter.transport.runtimeProvider,
    subscriptionId: subscription.id,
  }
}

const HEALTH_BY_FAILURE: Record<SubscriptionFailureKind, ModelSubscriptionHealthReason | null> = {
  auth: 'needs_reauthorization',
  entitlement: 'provider_rejected',
  policy: null,
  quota: 'quota_exhausted',
  transient: null,
  unknown: null,
}

/**
 * Record a provider failure against the credential generation that actually
 * failed.
 *
 * The epoch guard is the point: without it a 401 answered slowly by a token
 * that has since been replaced would mark a freshly relinked subscription as
 * broken. Only `auth` reaches `needs_reauthorization`; a quota window or a
 * content refusal is not a dead grant and must not show a relink button.
 */
export const recordSubscriptionFailure = async (
  deps: SubscriptionCoordinatorDeps,
  input: {
    subscriptionId: string
    epoch: number
    kind: SubscriptionFailureKind
    detail?: string
  },
): Promise<{ transitioned: boolean }> => {
  const reason = HEALTH_BY_FAILURE[input.kind]
  if (!reason) return { transitioned: false }
  const status = reason === 'needs_reauthorization' ? 'needs_reauthorization' : 'active'
  const updated = await deps.prisma.modelSubscription.updateMany({
    data: {
      healthDetail: input.detail ?? null,
      healthReason: reason,
      healthRevision: { increment: 1 },
      status,
    },
    where: {
      credentialEpoch: input.epoch,
      id: input.subscriptionId,
      NOT: { healthReason: reason },
    },
  })
  return { transitioned: updated.count === 1 }
}

/** Clear health after a run succeeds on this generation. */
export const recordSubscriptionSuccess = async (
  deps: SubscriptionCoordinatorDeps,
  input: { subscriptionId: string; epoch: number },
): Promise<void> => {
  await deps.prisma.modelSubscription.updateMany({
    data: { healthDetail: null, healthReason: 'ok', lastUsedAt: nowOf(deps) },
    where: {
      credentialEpoch: input.epoch,
      id: input.subscriptionId,
      NOT: { healthReason: 'ok' },
    },
  })
}

/**
 * Link a credential, or re-link an existing one.
 *
 * A relink must land on the SAME provider account: silently re-pointing a
 * subscription at a different account would move an agent's work to a stranger's
 * plan without anybody being told.
 */
export const linkSubscription = async (
  deps: SubscriptionCoordinatorDeps,
  input: {
    organizationId: string
    userId: string
    providerKey: string
    bundle: SubscriptionCredentialBundle
    /**
     * Identity already proven by the device flow's id_token. Supplied so an
     * OAuth link does not spend a second round trip re-deriving what the token
     * exchange just established.
     */
    identity?: SubscriptionAccountIdentity
    /** Set when re-linking a known row; refuses a different account. */
    subscriptionId?: string
  },
): Promise<{ subscription: ModelSubscription; created: boolean }> => {
  const store = requireStore(deps)
  const adapter = requireSubscriptionAdapter(input.providerKey)
  const identity = input.identity ?? (await adapter.verify(input.bundle))

  const existing = input.subscriptionId
    ? await deps.prisma.modelSubscription.findFirst({
      where: {
        id: input.subscriptionId,
        organizationId: input.organizationId,
        userId: input.userId,
      },
    })
    : await deps.prisma.modelSubscription.findUnique({
      where: {
        organizationId_userId_provider_providerAccountId: {
          organizationId: input.organizationId,
          provider: adapter.key,
          providerAccountId: identity.providerAccountId,
          userId: input.userId,
        },
      },
    })

  if (existing && existing.providerAccountId !== identity.providerAccountId) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.ACCOUNT_MISMATCH,
      'That credential belongs to a different account than the one linked here.',
    )
  }

  const subscription = existing
    ? await deps.prisma.modelSubscription.update({
      data: {
        accountLabel: identity.accountLabel ?? null,
        credentialEpoch: { increment: 1 },
        healthDetail: null,
        healthReason: 'ok',
        refreshClaimedAt: null,
        status: 'active',
      },
      where: { id: existing.id },
    })
    : await deps.prisma.modelSubscription.create({
      data: {
        accountLabel: identity.accountLabel ?? null,
        organizationId: input.organizationId,
        provider: adapter.key,
        providerAccountId: identity.providerAccountId,
        userId: input.userId,
      },
    })

  const name = subscriptionSecretName(subscription.id)
  await store.write({ bundle: input.bundle, name })
  await deps.prisma.modelSubscriptionCredential.upsert({
    create: {
      expiresAt: input.bundle.expiresAt === undefined ? null : new Date(input.bundle.expiresAt),
      subscriptionId: subscription.id,
      vaultReference: `vault://model-subscriptions/${name}`,
      vaultSecretName: name,
    },
    update: {
      expiresAt: input.bundle.expiresAt === undefined ? null : new Date(input.bundle.expiresAt),
    },
    where: { subscriptionId: subscription.id },
  })

  return { created: !existing, subscription }
}

/**
 * Disconnect a link.
 *
 * The tombstone is written in the SAME transaction that removes the pointer,
 * because a cascade that deletes the row without it would strand a live refresh
 * token in the vault that nothing can address any more. The sweep then deletes
 * it idempotently.
 */
export const disconnectSubscription = async (
  deps: SubscriptionCoordinatorDeps,
  input: { subscriptionId: string; organizationId: string; userId?: string },
): Promise<void> => {
  const subscription = await deps.prisma.modelSubscription.findFirst({
    where: {
      id: input.subscriptionId,
      organizationId: input.organizationId,
      ...(input.userId ? { userId: input.userId } : {}),
    },
  })
  if (!subscription) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
      'That personal subscription is no longer linked.',
    )
  }
  const name = subscriptionSecretName(subscription.id)
  await deps.prisma.$transaction([
    deps.prisma.modelSubscriptionVaultTombstone.create({
      data: {
        organizationId: subscription.organizationId,
        userId: subscription.userId,
        vaultSecretName: name,
      },
    }),
    // Agents keep their row and lose the pointer (SetNull). The run-time gate
    // then refuses with a named remedy, which is what a person expects to see.
    deps.prisma.modelSubscriptionCredential.deleteMany({
      where: { subscriptionId: subscription.id },
    }),
    deps.prisma.modelSubscription.update({
      data: { healthReason: 'ok', status: 'disconnected' },
      where: { id: subscription.id },
    }),
  ])
  await sweepSubscriptionVaultTombstones(deps, { limit: 10 })
}

/**
 * Delete vault secrets whose pointers are gone. Idempotent by construction: an
 * already-absent secret counts as deleted, so a retry after a partial failure
 * converges instead of erroring forever.
 */
export const sweepSubscriptionVaultTombstones = async (
  deps: SubscriptionCoordinatorDeps,
  options: { limit?: number } = {},
): Promise<{ deleted: number }> => {
  if (!deps.secretStore) return { deleted: 0 }
  const pending = await deps.prisma.modelSubscriptionVaultTombstone.findMany({
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 50,
    where: { deletedAt: null },
  })
  let deleted = 0
  for (const tombstone of pending) {
    try {
      await deps.secretStore.remove(tombstone.vaultSecretName)
      await deps.prisma.modelSubscriptionVaultTombstone.update({
        data: { deletedAt: nowOf(deps) },
        where: { id: tombstone.id },
      })
      deleted += 1
    } catch (error) {
      await deps.prisma.modelSubscriptionVaultTombstone
        .update({
          data: {
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
          },
          where: { id: tombstone.id },
        })
        .catch(() => undefined)
    }
  }
  return { deleted }
}

/**
 * Every subscription a person may currently select, newest account first.
 * Deactivated members get nothing — the same liveness re-derivation the spend
 * path performs.
 */
export const listUserSubscriptions = async (
  deps: SubscriptionCoordinatorDeps,
  input: { organizationId: string; userId: string; activeOnly?: boolean },
): Promise<ModelSubscription[]> => {
  const membership = await deps.prisma.organizationMember.findUnique({
    select: { deactivatedAt: true },
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.userId,
      },
    },
  })
  if (!membership || membership.deactivatedAt !== null) return []
  return deps.prisma.modelSubscription.findMany({
    orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      ...(input.activeOnly === false ? {} : { status: 'active' }),
    },
  })
}

/** Raw SQL escape hatch used by the tombstone sweep tests. */
export const subscriptionTombstoneCount = async (
  deps: SubscriptionCoordinatorDeps,
): Promise<number> => {
  const rows = await deps.prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM model_subscription_vault_tombstones WHERE deleted_at IS NULL`,
  )
  return Number(rows[0]?.count ?? 0)
}
