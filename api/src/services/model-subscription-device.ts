import type { PrismaClient } from '@prisma/client'
import {
  deviceFlowForAdapter,
  generateDeviceStateToken,
  linkSubscription,
  ModelSubscriptionError,
  requireSubscriptionAdapter,
  SUBSCRIPTION_ERROR_CODES,
  subscriptionSecretName,
  type SubscriptionCoordinatorDeps,
  type SubscriptionCredentialBundle,
} from '@nessie/model-subscriptions'

/**
 * Device-code linking, driven from the server.
 *
 * Three properties this shape buys, each deliberate:
 *
 * - **The browser never holds a token.** The exchange happens here; the client
 *   only ever sees a short code, a link, and eventually a verified identity.
 * - **Polling is leased.** Several tabs, or several API replicas, must not each
 *   hammer the provider on a shared public client. One caller at a time holds
 *   the lease, and `nextPollAt` honours the provider's own interval and any
 *   `slow_down` it sends.
 * - **A first link is confirmed before it can spend.** The credential is parked
 *   in the vault under a pending name and the subscription is only created once
 *   the person has seen WHICH account signed in — the device-flow confused
 *   deputy is that somebody else enters your code and their account gets
 *   attached to your team.
 *
 * Spec: docs/plans/2026-09-02-personal-model-subscriptions.md §2.5.
 */

const STATE_TTL_MS = 20 * 60_000
const POLL_LEASE_MS = 30_000

type StatePayload = {
  pollState: Record<string, unknown>
  intervalMs: number
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  /** Set once the exchange has produced a credential awaiting confirmation. */
  pendingSecretName?: string
  pendingAccountId?: string
  pendingAccountLabel?: string
  /** Set when re-linking an existing row, so the account can be matched. */
  targetSubscriptionId?: string
  expectedAccountId?: string
}

export type DeviceStartResult = {
  stateToken: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: string
  intervalMs: number
}

export type DevicePollResult =
  | { status: 'pending'; intervalMs: number }
  | { status: 'awaiting_confirmation'; accountId: string; accountLabel?: string }
  | { status: 'denied'; reason: string }
  | { status: 'expired' }

const readPayload = (value: unknown): StatePayload =>
  (value ?? {}) as StatePayload

export const startDeviceAuthorization = async (
  deps: SubscriptionCoordinatorDeps,
  input: {
    organizationId: string
    userId: string
    providerKey: string
    /** Re-link: binds the flow to the account already linked on that row. */
    subscriptionId?: string
  },
): Promise<DeviceStartResult> => {
  const adapter = requireSubscriptionAdapter(input.providerKey)
  const flow = deviceFlowForAdapter(adapter.key)
  if (!flow) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.ADAPTER_UNKNOWN,
      `${adapter.displayName} is linked with a key, not a sign-in.`,
    )
  }
  // Refuse before reaching the provider when there is nowhere to put the
  // result — a person should not complete a sign-in that cannot be stored.
  if (!deps.secretStore) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE,
      'Personal subscriptions are not available on this deployment.',
    )
  }

  let expectedAccountId: string | undefined
  if (input.subscriptionId) {
    const existing = await deps.prisma.modelSubscription.findFirst({
      where: {
        id: input.subscriptionId,
        organizationId: input.organizationId,
        userId: input.userId,
      },
    })
    if (!existing) {
      throw new ModelSubscriptionError(
        SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
        'That personal subscription is no longer linked.',
      )
    }
    expectedAccountId = existing.providerAccountId
  }

  const started = await flow.start()
  const stateToken = generateDeviceStateToken()
  const payload: StatePayload = {
    intervalMs: started.intervalMs,
    pollState: started.pollState,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    ...(started.verificationUriComplete
      ? { verificationUriComplete: started.verificationUriComplete }
      : {}),
    ...(input.subscriptionId ? { targetSubscriptionId: input.subscriptionId } : {}),
    ...(expectedAccountId ? { expectedAccountId } : {}),
  }

  const expiresAt = new Date(Math.min(started.expiresAt, Date.now() + STATE_TTL_MS))
  await deps.prisma.modelSubscriptionAuthState.create({
    data: {
      expiresAt,
      nextPollAt: new Date(Date.now() + started.intervalMs),
      organizationId: input.organizationId,
      payload: payload as never,
      provider: adapter.key,
      token: stateToken,
      userId: input.userId,
    },
  })

  return {
    expiresAt: expiresAt.toISOString(),
    intervalMs: started.intervalMs,
    stateToken,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    ...(started.verificationUriComplete
      ? { verificationUriComplete: started.verificationUriComplete }
      : {}),
  }
}

export const pollDeviceAuthorization = async (
  deps: SubscriptionCoordinatorDeps,
  input: { organizationId: string; userId: string; stateToken: string },
): Promise<DevicePollResult> => {
  const now = new Date()
  const state = await deps.prisma.modelSubscriptionAuthState.findFirst({
    where: {
      consumedAt: null,
      organizationId: input.organizationId,
      token: input.stateToken,
      userId: input.userId,
    },
  })
  if (!state) return { status: 'expired' }
  if (state.expiresAt <= now) return { status: 'expired' }

  const payload = readPayload(state.payload)

  // Already exchanged and waiting for the person to confirm the account.
  if (payload.pendingSecretName && payload.pendingAccountId) {
    return {
      accountId: payload.pendingAccountId,
      ...(payload.pendingAccountLabel ? { accountLabel: payload.pendingAccountLabel } : {}),
      status: 'awaiting_confirmation',
    }
  }

  // One poller at a time, and never before the provider's own interval has
  // elapsed. The conditional UPDATE carries both decisions, so a second tab
  // simply reports "pending" instead of racing to the provider.
  const claimed = await deps.prisma.modelSubscriptionAuthState.updateMany({
    data: { pollLeaseUntil: new Date(now.getTime() + POLL_LEASE_MS) },
    where: {
      OR: [{ pollLeaseUntil: null }, { pollLeaseUntil: { lte: now } }],
      AND: [{ OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] }],
      consumedAt: null,
      token: input.stateToken,
    },
  })
  if (claimed.count !== 1) {
    return { intervalMs: payload.intervalMs, status: 'pending' }
  }

  const adapter = requireSubscriptionAdapter(state.provider)
  const flow = deviceFlowForAdapter(adapter.key)
  if (!flow) return { status: 'expired' }

  let result
  try {
    result = await flow.poll(payload.pollState)
  } finally {
    await deps.prisma.modelSubscriptionAuthState
      .updateMany({ data: { pollLeaseUntil: null }, where: { token: input.stateToken } })
      .catch(() => undefined)
  }

  if (result.status === 'pending') {
    await deps.prisma.modelSubscriptionAuthState.updateMany({
      data: { nextPollAt: new Date(Date.now() + result.intervalMs) },
      where: { token: input.stateToken },
    })
    return { intervalMs: result.intervalMs, status: 'pending' }
  }
  if (result.status === 'expired') {
    await consumeState(deps, input.stateToken)
    return { status: 'expired' }
  }
  if (result.status === 'denied') {
    await consumeState(deps, input.stateToken)
    return { reason: result.reason, status: 'denied' }
  }

  // A relink must land on the SAME account. Refusing here — before anything is
  // stored — is what stops a different sign-in silently re-pointing an agent's
  // work at a stranger's plan.
  if (payload.expectedAccountId
    && payload.expectedAccountId !== result.identity.providerAccountId) {
    await consumeState(deps, input.stateToken)
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.ACCOUNT_MISMATCH,
      'That sign-in was for a different account than the one linked here.',
    )
  }

  // Park the credential in the vault under a pending name. It becomes
  // spendable only once the person confirms the account below.
  const pendingSecretName = `pending-${input.stateToken}`
  await requireStore(deps).write({ bundle: result.bundle, name: pendingSecretName })
  const nextPayload: StatePayload = {
    ...payload,
    pendingAccountId: result.identity.providerAccountId,
    ...(result.identity.accountLabel
      ? { pendingAccountLabel: result.identity.accountLabel }
      : {}),
    pendingSecretName,
  }
  await deps.prisma.modelSubscriptionAuthState.updateMany({
    data: { payload: nextPayload as never },
    where: { token: input.stateToken },
  })

  return {
    accountId: result.identity.providerAccountId,
    ...(result.identity.accountLabel ? { accountLabel: result.identity.accountLabel } : {}),
    status: 'awaiting_confirmation',
  }
}

export const confirmDeviceAuthorization = async (
  deps: SubscriptionCoordinatorDeps,
  input: { organizationId: string; userId: string; stateToken: string },
): Promise<{ subscriptionId: string; created: boolean }> => {
  const state = await deps.prisma.modelSubscriptionAuthState.findFirst({
    where: {
      consumedAt: null,
      organizationId: input.organizationId,
      token: input.stateToken,
      userId: input.userId,
    },
  })
  const payload = state ? readPayload(state.payload) : null
  if (!state || !payload?.pendingSecretName || !payload.pendingAccountId) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
      'That sign-in is no longer waiting to be confirmed.',
    )
  }
  if (state.expiresAt <= new Date()) {
    await consumeState(deps, input.stateToken)
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.NOT_FOUND,
      'That sign-in expired before it was confirmed.',
    )
  }

  const store = requireStore(deps)
  const bundle: SubscriptionCredentialBundle = await store.read(payload.pendingSecretName)
  const { created, subscription } = await linkSubscription(deps, {
    bundle,
    identity: {
      ...(payload.pendingAccountLabel ? { accountLabel: payload.pendingAccountLabel } : {}),
      providerAccountId: payload.pendingAccountId,
    },
    organizationId: input.organizationId,
    providerKey: state.provider,
    ...(payload.targetSubscriptionId
      ? { subscriptionId: payload.targetSubscriptionId }
      : {}),
    userId: input.userId,
  })

  // The real secret now holds the credential; the pending copy is tombstoned
  // rather than deleted inline so a vault hiccup cannot strand it.
  await deps.prisma.modelSubscriptionVaultTombstone.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      vaultSecretName: payload.pendingSecretName,
    },
  })
  await consumeState(deps, input.stateToken)
  void subscriptionSecretName(subscription.id)
  return { created, subscriptionId: subscription.id }
}

/** Abandon a flow: consume the state and tombstone any parked credential. */
export const cancelDeviceAuthorization = async (
  deps: SubscriptionCoordinatorDeps,
  input: { organizationId: string; userId: string; stateToken: string },
): Promise<void> => {
  const state = await deps.prisma.modelSubscriptionAuthState.findFirst({
    where: {
      organizationId: input.organizationId,
      token: input.stateToken,
      userId: input.userId,
    },
  })
  if (!state) return
  const payload = readPayload(state.payload)
  if (payload.pendingSecretName) {
    await deps.prisma.modelSubscriptionVaultTombstone.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        vaultSecretName: payload.pendingSecretName,
      },
    })
  }
  await consumeState(deps, input.stateToken)
}

const consumeState = async (
  deps: SubscriptionCoordinatorDeps,
  token: string,
): Promise<void> => {
  await deps.prisma.modelSubscriptionAuthState
    .updateMany({ data: { consumedAt: new Date() }, where: { consumedAt: null, token } })
    .catch(() => undefined)
}

const requireStore = (deps: SubscriptionCoordinatorDeps) => {
  if (!deps.secretStore) {
    throw new ModelSubscriptionError(
      SUBSCRIPTION_ERROR_CODES.VAULT_UNAVAILABLE,
      'Personal subscriptions are not available on this deployment.',
    )
  }
  return deps.secretStore
}

export const _internals = { POLL_LEASE_MS, STATE_TTL_MS }

export type { PrismaClient }
