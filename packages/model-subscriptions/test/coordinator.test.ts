import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrismaClient } from '@prisma/client'
import {
  createInMemorySubscriptionSecretStore,
  disconnectSubscription,
  linkSubscription,
  loadSpendableSubscription,
  recordSubscriptionFailure,
  resolveSubscriptionCredential,
  subscriptionSecretName,
  sweepSubscriptionVaultTombstones,
} from '../src/index.js'
import { ModelSubscriptionError } from '../src/types.js'

/**
 * These exercise the rules that make a credential safe to share between a
 * person and their unattended agents: liveness re-derivation, the epoch guard
 * on failure transitions, and the vault tombstone that stops a live refresh
 * token outliving its pointer.
 */

type Row = Record<string, unknown>

const makeFake = (seed: {
  subscription?: Row | null
  membership?: Row | null
  credential?: Row | null
}) => {
  const state = {
    credential: seed.credential ?? null,
    membership: seed.membership ?? null,
    subscription: seed.subscription ?? null,
    tombstones: [] as Row[],
    updates: [] as Row[],
  }
  const prisma = {
    $transaction: async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]),
    modelSubscription: {
      findFirst: async () => state.subscription,
      findUnique: async () => state.subscription,
      update: async ({ data }: { data: Row }) => {
        state.subscription = { ...(state.subscription as Row), ...data }
        return state.subscription
      },
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        state.updates.push({ data, where })
        const current = state.subscription as Row | null
        if (!current) return { count: 0 }
        // Mirror the conditional UPDATE: the WHERE carries the decision, so a
        // mismatched epoch simply updates nothing.
        if (where.credentialEpoch !== undefined
          && where.credentialEpoch !== current.credentialEpoch) {
          return { count: 0 }
        }
        if ((where.NOT as Row | undefined)?.healthReason === current.healthReason) {
          return { count: 0 }
        }
        state.subscription = { ...current, ...data }
        return { count: 1 }
      },
    },
    modelSubscriptionCredential: {
      deleteMany: async () => ({ count: 1 }),
      findUnique: async () => state.credential,
      updateMany: async () => ({ count: 1 }),
      upsert: async () => state.credential,
    },
    modelSubscriptionVaultTombstone: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, deletedAt: null, id: `t-${state.tombstones.length}` }
        state.tombstones.push(row)
        return row
      },
      findMany: async () => state.tombstones.filter((row) => row.deletedAt === null),
      update: async ({ data, where }: { data: Row; where: Row }) => {
        const row = state.tombstones.find((entry) => entry.id === where.id)
        if (row) Object.assign(row, data)
        return row
      },
    },
    organizationMember: {
      findUnique: async () => state.membership,
    },
  } as unknown as PrismaClient
  return { prisma, state }
}

const ACTIVE_SUBSCRIPTION = {
  createdAt: new Date(),
  credentialEpoch: 3,
  healthReason: 'ok',
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  provider: 'glm',
  providerAccountId: 'acct-1',
  status: 'active',
  userId: 'user-1',
}

test('a deactivated owner cannot spend their subscription', async () => {
  // The composite FK proves the membership row EXISTS; deactivated rows are
  // retained deliberately, so liveness has to be re-derived on every read.
  const { prisma } = makeFake({
    membership: { deactivatedAt: new Date() },
    subscription: ACTIVE_SUBSCRIPTION,
  })
  await assert.rejects(
    loadSpendableSubscription(
      { prisma, secretStore: null },
      { organizationId: 'org-1', subscriptionId: ACTIVE_SUBSCRIPTION.id },
    ),
    (error: unknown) =>
      error instanceof ModelSubscriptionError
      && error.code === 'MODEL_SUBSCRIPTION_OWNER_INACTIVE',
  )
})

test('a subscription belonging to another person is indistinguishable from absent', async () => {
  const { prisma } = makeFake({
    membership: { deactivatedAt: null },
    subscription: ACTIVE_SUBSCRIPTION,
  })
  await assert.rejects(
    loadSpendableSubscription(
      { prisma, secretStore: null },
      {
        expectedOwnerUserId: 'someone-else',
        organizationId: 'org-1',
        subscriptionId: ACTIVE_SUBSCRIPTION.id,
      },
    ),
    (error: unknown) =>
      error instanceof ModelSubscriptionError
      && error.code === 'MODEL_SUBSCRIPTION_NOT_FOUND',
  )
})

test('a stale 401 cannot mark a freshly relinked subscription as broken', async () => {
  // The delayed-failure race: a request made with credential generation 2
  // answers 401 after the person has already relinked (generation 3). Without
  // the epoch guard this would show a relink button on a healthy link.
  const { prisma, state } = makeFake({
    membership: { deactivatedAt: null },
    subscription: { ...ACTIVE_SUBSCRIPTION, credentialEpoch: 3 },
  })
  const stale = await recordSubscriptionFailure(
    { prisma, secretStore: null },
    { epoch: 2, kind: 'auth', subscriptionId: ACTIVE_SUBSCRIPTION.id },
  )
  assert.equal(stale.transitioned, false)
  assert.equal((state.subscription as Row).status, 'active')

  const current = await recordSubscriptionFailure(
    { prisma, secretStore: null },
    { epoch: 3, kind: 'auth', subscriptionId: ACTIVE_SUBSCRIPTION.id },
  )
  assert.equal(current.transitioned, true)
  assert.equal((state.subscription as Row).status, 'needs_reauthorization')
})

test('a quota refusal never presents itself as a dead credential', async () => {
  const { prisma, state } = makeFake({
    membership: { deactivatedAt: null },
    subscription: { ...ACTIVE_SUBSCRIPTION },
  })
  await recordSubscriptionFailure(
    { prisma, secretStore: null },
    { epoch: 3, kind: 'quota', subscriptionId: ACTIVE_SUBSCRIPTION.id },
  )
  assert.equal((state.subscription as Row).status, 'active')
  assert.equal((state.subscription as Row).healthReason, 'quota_exhausted')
})

test('resolving a credential reads the bundle from the vault, never the database', async () => {
  const store = createInMemorySubscriptionSecretStore()
  const name = subscriptionSecretName(ACTIVE_SUBSCRIPTION.id)
  await store.write({ bundle: { accessToken: 'key-live' }, name })
  const { prisma } = makeFake({
    credential: { vaultSecretName: name },
    membership: { deactivatedAt: null },
    subscription: ACTIVE_SUBSCRIPTION,
  })
  const resolved = await resolveSubscriptionCredential(
    { prisma, secretStore: store },
    { organizationId: 'org-1', subscriptionId: ACTIVE_SUBSCRIPTION.id },
  )
  assert.equal(resolved.accessToken, 'key-live')
  assert.equal(resolved.epoch, 3)
  assert.equal(resolved.baseUrl, 'https://api.z.ai/api/paas/v4')
  assert.equal(resolved.runtimeProvider, 'openai-compatible')
})

test('linking without a configured vault refuses instead of storing in Postgres', async () => {
  const { prisma } = makeFake({ membership: { deactivatedAt: null } })
  await assert.rejects(
    linkSubscription(
      { prisma, secretStore: null },
      {
        bundle: { accessToken: 'sk-whatever-123456' },
        organizationId: 'org-1',
        providerKey: 'kimi',
        userId: 'user-1',
      },
    ),
    (error: unknown) =>
      error instanceof ModelSubscriptionError
      && error.code === 'MODEL_SUBSCRIPTION_VAULT_UNAVAILABLE',
  )
})

test('disconnect tombstones the vault secret and the sweep deletes it', async () => {
  // Without the tombstone a cascade would strand a live refresh token that
  // nothing in the database can address any more.
  const store = createInMemorySubscriptionSecretStore()
  const name = subscriptionSecretName(ACTIVE_SUBSCRIPTION.id)
  await store.write({ bundle: { accessToken: 'key-live' }, name })
  const { prisma, state } = makeFake({
    credential: { vaultSecretName: name },
    membership: { deactivatedAt: null },
    subscription: ACTIVE_SUBSCRIPTION,
  })

  await disconnectSubscription(
    { prisma, secretStore: store },
    { organizationId: 'org-1', subscriptionId: ACTIVE_SUBSCRIPTION.id, userId: 'user-1' },
  )
  assert.equal(state.tombstones.length, 1)
  assert.equal(store.entries.has(name), false)
  assert.equal((state.subscription as Row).status, 'disconnected')

  // Idempotent: an already-absent secret counts as deleted, so a retry after a
  // partial failure converges rather than erroring forever.
  const again = await sweepSubscriptionVaultTombstones({ prisma, secretStore: store })
  assert.equal(again.deleted, 0)
})
