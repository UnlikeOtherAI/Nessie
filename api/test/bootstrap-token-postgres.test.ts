import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  BootstrapTokenRejectedError,
  claimBootstrapToken,
  ensureBootstrapToken,
} from '../src/auth/bootstrap.js'
import { lockBootstrapInitialization } from '../src/db/seed.js'

/**
 * The owner-bootstrap token lives in one Postgres row rather than in each
 * process's memory (audit 1.2). What the row has to guarantee: two replicas
 * read the SAME token, a token can be burned exactly once, and a token that
 * expired unconsumed is replaced rather than leaving the install unreachable.
 *
 * These use two independent `PrismaClient`s so the assertions cross a
 * connection boundary — with the old closure the second replica had a
 * different token and the exchange failed `TOKEN_INVALID` wherever it landed.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

/**
 * The whole-install check the audit describes: two server contexts, i.e. two
 * `randomUUID()` mints under the old code. It needs an install with no users,
 * so it follows `team-bootstrap-postgres-race.test.ts` and stays opt-in rather
 * than flaking against the shared database:
 *
 *   DATABASE_URL=<pristine db> NESSIE_TEST_PRISTINE_DATABASE=1 \
 *     node --test --import tsx test/bootstrap-token-postgres.test.ts
 */
const runPristineDatabaseTest =
  process.env.DATABASE_URL && process.env.NESSIE_TEST_PRISTINE_DATABASE === '1'
    ? test
    : test.skip

const resolveThroughConnection = (prisma: PrismaClient) =>
  prisma.$transaction(async (transaction) => {
    await lockBootstrapInitialization(transaction)
    return ensureBootstrapToken(transaction)
  })

const clearBootstrapTokens = (prisma: PrismaClient) =>
  prisma.bootstrapToken.deleteMany({})

runDatabaseTest('two connections resolve one shared bootstrap token', async (t) => {
  const left = new PrismaClient()
  const right = new PrismaClient()
  t.after(async () => {
    await clearBootstrapTokens(left)
    await Promise.all([left.$disconnect(), right.$disconnect()])
  })
  await clearBootstrapTokens(left)

  const minted = await resolveThroughConnection(left)
  const seenByOther = await resolveThroughConnection(right)

  // The assertion that fails without the fix: the old per-process mint gave
  // each replica its own `randomUUID()`.
  assert.equal(seenByOther.token, minted.token)
  assert.equal(seenByOther.expiresAt.getTime(), minted.expiresAt.getTime())
  assert.equal(await left.bootstrapToken.count(), 1, 'the table stays single-row')
})

runDatabaseTest('a consumed token is refused, and only the first claim wins', async (t) => {
  const prisma = new PrismaClient()
  t.after(async () => {
    await clearBootstrapTokens(prisma)
    await prisma.$disconnect()
  })
  await clearBootstrapTokens(prisma)

  const minted = await resolveThroughConnection(prisma)
  await prisma.$transaction((transaction) => claimBootstrapToken(transaction, minted.token))

  const consumed = await prisma.bootstrapToken.findFirst({ select: { consumedAt: true } })
  assert.ok(consumed?.consumedAt, 'the winning claim stamps consumed_at')

  // The assertion that fails without the fix: comparing against an in-memory
  // token has no notion of "already used", so a replay would be accepted.
  await assert.rejects(
    prisma.$transaction((transaction) => claimBootstrapToken(transaction, minted.token)),
    BootstrapTokenRejectedError,
  )
  await assert.rejects(
    prisma.$transaction((transaction) => claimBootstrapToken(transaction, 'never-issued')),
    BootstrapTokenRejectedError,
  )
})

runDatabaseTest('an expired token is re-minted, and the expired one stays refused', async (t) => {
  const prisma = new PrismaClient()
  t.after(async () => {
    await clearBootstrapTokens(prisma)
    await prisma.$disconnect()
  })
  await clearBootstrapTokens(prisma)

  const stale = await resolveThroughConnection(prisma)
  await prisma.bootstrapToken.updateMany({
    data: { expiresAt: new Date(Date.now() - 60_000) },
  })

  const fresh = await resolveThroughConnection(prisma)

  // The assertions that fail without the fix: an expired token used to be
  // returned as-is until somebody restarted the process, so `fresh` was the
  // stale token and the install stayed unreachable.
  assert.notEqual(fresh.token, stale.token)
  assert.ok(fresh.expiresAt.getTime() > Date.now())
  assert.equal(await prisma.bootstrapToken.count(), 1, 'a re-mint replaces, never accumulates')
  await assert.rejects(
    prisma.$transaction((transaction) => claimBootstrapToken(transaction, stale.token)),
    BootstrapTokenRejectedError,
  )
})

runPristineDatabaseTest(
  'two server contexts resolve the same bootstrap token',
  async (t) => {
    process.env.NESSIE_AUTH_SECRET ??= 'ab'.repeat(32)
    const { createServerContext } = await import('../src/lib/server-context.js')
    const prisma = new PrismaClient()
    t.after(async () => {
      await clearBootstrapTokens(prisma)
      await prisma.$disconnect()
    })
    await clearBootstrapTokens(prisma)
    assert.equal(await prisma.user.count(), 0, 'bootstrap only arms on an install with no users')

    const first = await createServerContext().resolveBootstrapState()
    const second = await createServerContext().resolveBootstrapState()

    assert.ok(first, 'an install with no users arms bootstrap mode')
    assert.equal(second?.token, first.token)
    assert.equal(await prisma.bootstrapToken.count(), 1)
  },
)
