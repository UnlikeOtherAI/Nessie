import assert from 'node:assert/strict'
import test from 'node:test'

import { decryptWithKey, deriveSecretKey } from '@nessie/runtime'

import {
  consumeRefreshToken,
  hashRefreshToken,
  issueRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
  UoaRefreshBindingError,
} from '../src/services/refresh-token.js'
import {
  AUTH_SECRET,
  consume,
  createRefreshFixture,
  defaultUoaRefresh,
  FakeRefreshTokenPrisma,
  ORGANIZATION_ID,
  SESSION_ID,
  TTL_SECONDS,
  UOA_IDENTITY,
  USER_ID,
  type RefreshCallback,
} from './refresh-token-fixture.js'

const createFixture = createRefreshFixture

test('active refresh rotates local and encrypted upstream credentials atomically', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let callbackTransaction: unknown
  const refresh = defaultUoaRefresh(now)

  const result = await consume(fake, rawToken, now, async (input, transaction) => {
    callbackTransaction = transaction
    return refresh(input, transaction)
  })

  assert.equal(result.ok, true)
  assert.strictEqual(callbackTransaction, fake.asClient())
  if (!result.ok) return
  assert.equal(result.replayed, false)
  assert.deepEqual(result.uoaIdentity, UOA_IDENTITY)
  assert.notEqual(result.rawToken, rawToken)
  assert.equal(fake.records.size, 2)

  const predecessor = fake.findByHash(hashRefreshToken(rawToken))
  const successor = fake.findByHash(hashRefreshToken(result.rawToken))
  assert.equal(predecessor?.revokedAt, now)
  assert.equal(predecessor?.replacedById, successor?.id)
  assert.equal(successor?.revokedAt, null)
  assert.equal('rawToken' in (successor ?? {}), false)

  const credential = fake.uoaCredentials.get(predecessor!.familyId)
  assert.equal(credential?.lastLocalTokenId, successor?.id)
  assert.equal(credential?.generation, 1)
  assert.equal(credential?.refreshTokenHash, hashRefreshToken('uoa-refresh-1.next'))
  assert.notEqual(credential?.refreshTokenCiphertext, 'uoa-refresh-1.next')
  assert.equal(
    decryptWithKey(deriveSecretKey(AUTH_SECRET), {
      authTag: credential!.refreshTokenAuthTag,
      ciphertext: credential!.refreshTokenCiphertext,
      iv: credential!.refreshTokenIv,
    }),
    'uoa-refresh-1.next',
  )
})

test('simultaneous refreshes converge on the same local and UOA successor', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let upstreamCalls = 0
  const refresh = defaultUoaRefresh(now)
  const countedRefresh: RefreshCallback = async (input) => {
    upstreamCalls += 1
    return refresh(input)
  }

  const [left, right] = await Promise.all([
    consume(fake, rawToken, now, countedRefresh),
    consume(fake, rawToken, now, countedRefresh),
  ])

  assert.equal(left.ok, true)
  assert.equal(right.ok, true)
  if (!left.ok || !right.ok) return
  assert.equal(left.rawToken, right.rawToken)
  assert.deepEqual([left.replayed, right.replayed].sort(), [false, true])
  assert.equal(upstreamCalls, 1)
  assert.equal(fake.records.size, 2)
  assert.equal(fake.uoaCredentials.values().next().value?.generation, 1)
  assert.equal(
    Array.from(fake.records.values()).filter((record) => !record.revokedAt).length,
    1,
  )
})

test('lost local commit retries the same replay-safe UOA rotation', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let upstreamCalls = 0
  const refresh = defaultUoaRefresh(now)
  const countedRefresh: RefreshCallback = async (input) => {
    upstreamCalls += 1
    return refresh(input)
  }
  fake.failNextTransaction = true

  await assert.rejects(
    consume(fake, rawToken, now, countedRefresh),
    /simulated local commit failure/,
  )
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)

  const retry = await consume(fake, rawToken, now, countedRefresh)
  assert.equal(retry.ok, true)
  assert.equal(upstreamCalls, 2)
})

test('same predecessor replay inside grace never calls UOA again', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const rotated = await consume(fake, rawToken, now)
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return
  let upstreamCalls = 0

  const replay = await consume(
    fake,
    rawToken,
    new Date(now.getTime() + 1_000),
    async () => {
      upstreamCalls += 1
      throw new Error('must not refresh upstream')
    },
  )

  assert.equal(replay.ok, true)
  if (!replay.ok) return
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.uoaIdentity, UOA_IDENTITY)
  assert.equal(replay.rawToken, rotated.rawToken)
  assert.equal(upstreamCalls, 0)
})

test('predecessor replay makes a concurrently held current cookie converge', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const rotated = await consume(fake, rawToken, now)
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return

  const predecessorResponse = await consume(
    fake,
    rawToken,
    new Date(now.getTime() + 1_000),
  )
  let upstreamCalls = 0
  const currentResponse = await consume(
    fake,
    rotated.rawToken,
    new Date(now.getTime() + 2_000),
    async () => {
      upstreamCalls += 1
      throw new Error('the replay barrier must return the current cookie')
    },
  )

  assert.equal(predecessorResponse.ok, true)
  assert.equal(currentResponse.ok, true)
  if (!predecessorResponse.ok || !currentResponse.ok) return
  assert.equal(predecessorResponse.rawToken, rotated.rawToken)
  assert.equal(currentResponse.rawToken, rotated.rawToken)
  assert.equal(upstreamCalls, 0)
})

test('slow upstream work starts the local replay grace at commit time', async () => {
  const { fake, rawToken } = await createFixture()
  const startedAt = new Date('2026-07-22T00:00:00.000Z')
  const committedAt = new Date(
    startedAt.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS - 1_000,
  )
  let clockReads = 0
  const rotated = await consumeRefreshToken(fake.asClient(), {
    authSecret: AUTH_SECRET,
    rawToken,
    ttlSeconds: TTL_SECONDS,
    clock: () => {
      clockReads += 1
      return clockReads === 1 ? startedAt : committedAt
    },
    refreshUoaSession: async (input) => ({
      identity: input.expectedIdentity,
      refreshToken: `${input.refreshToken}.next`,
      refreshTokenExpiresAt: new Date(committedAt.getTime() + 86_400_000),
    }),
  })
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return
  assert.equal(
    fake.findByHash(hashRefreshToken(rawToken))?.revokedAt?.getTime(),
    committedAt.getTime(),
  )

  const replay = await consume(
    fake,
    rawToken,
    new Date(committedAt.getTime() + 1_000),
  )
  assert.equal(replay.ok, true)
  if (replay.ok) assert.equal(replay.rawToken, rotated.rawToken)
})

test('grace replay follows verified replacements to the current live descendant', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const first = await consume(fake, rawToken, now)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const second = await consume(fake, first.rawToken, new Date(now.getTime() + 10_000))
  assert.equal(second.ok, true)
  if (!second.ok) return

  const replay = await consume(fake, rawToken, new Date(now.getTime() + 20_000))

  assert.equal(replay.ok, true)
  if (!replay.ok) return
  assert.equal(replay.replayed, true)
  assert.equal(replay.rawToken, second.rawToken)
})

test('predecessor replay after grace revokes local and encrypted family state', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const rotated = await consume(fake, rawToken, now)
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return

  const replay = await consume(
    fake,
    rawToken,
    new Date(now.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 1),
  )

  assert.deepEqual(replay, { ok: false, reason: 'reuse' })
  assert.ok(Array.from(fake.records.values()).every((record) => record.revokedAt))
  assert.equal(fake.uoaCredentials.size, 0)
})

test('expired local session erases its encrypted UOA credential', async () => {
  const { fake, rawToken } = await createFixture()

  const result = await consume(
    fake,
    rawToken,
    new Date(Date.now() + (TTL_SECONDS + 1) * 1_000),
  )

  assert.deepEqual(result, { ok: false, reason: 'expired' })
  assert.ok(Array.from(fake.records.values()).every((record) => record.revokedAt))
  assert.equal(fake.uoaCredentials.size, 0)
})

test('transient UOA failure leaves the presented family active for retry', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  await assert.rejects(
    consume(fake, rawToken, now, async () => { throw new Error('temporary outage') }),
    /temporary outage/,
  )
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
  assert.equal(fake.uoaCredentials.size, 1)
  assert.equal((await consume(fake, rawToken, now)).ok, true)
})

test('rejects a changed UOA binding before any local rotation', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  await assert.rejects(
    consume(fake, rawToken, now, async (input) => ({
      identity: { ...input.expectedIdentity, teamId: 'different-team' },
      refreshToken: `${input.refreshToken}.next`,
      refreshTokenExpiresAt: new Date(now.getTime() + 60_000),
    })),
    UoaRefreshBindingError,
  )
  assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
})

test('rejects issuing a UOA family without its encrypted immutable proof', async () => {
  const fake = new FakeRefreshTokenPrisma()
  await assert.rejects(
    issueRefreshToken(fake.asClient(), {
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      sessionId: SESSION_ID,
      providerId: 'uoa',
      providerType: 'uoa',
      ttlSeconds: TTL_SECONDS,
    }),
    /UOA session does not match its provider/,
  )
  assert.equal(fake.records.size, 0)
  assert.equal(fake.uoaCredentials.size, 0)
})

test('legacy UOA families without encrypted proof must sign in again', async () => {
  const fake = new FakeRefreshTokenPrisma()
  const rawToken = 'legacy-local-uoa-token'
  await fake.refreshToken.create({
    data: {
      userId: USER_ID,
      familyId: '00000000-0000-4000-8000-000000000003',
      sessionId: SESSION_ID,
      providerId: 'uoa',
      providerType: 'uoa',
      tokenHash: hashRefreshToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
    },
  })

  await assert.rejects(
    consume(fake, rawToken, new Date()),
    /legacy UnlikeOtherAI session must sign in again/,
  )
})

test('tampered replacement chain is rejected and revokes its family', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const rotated = await consume(fake, rawToken, now)
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return

  const successor = fake.findByHash(hashRefreshToken(rotated.rawToken))
  assert.ok(successor)
  successor.tokenHash = hashRefreshToken('attacker-controlled-token')

  const replay = await consume(fake, rawToken, new Date(now.getTime() + 1_000))

  assert.deepEqual(replay, { ok: false, reason: 'reuse' })
  assert.ok(Array.from(fake.records.values()).every((record) => record.revokedAt))
  assert.equal(fake.uoaCredentials.size, 0)
})

test('excessive replacement depth is treated as a tampered chain', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  let currentRawToken = rawToken

  for (let index = 0; index < 33; index += 1) {
    const rotated = await consume(fake, currentRawToken, now)
    assert.equal(rotated.ok, true)
    if (!rotated.ok) return
    currentRawToken = rotated.rawToken
  }

  const replay = await consume(fake, rawToken, new Date(now.getTime() + 1_000))

  assert.deepEqual(replay, { ok: false, reason: 'reuse' })
  assert.ok(Array.from(fake.records.values()).every((record) => record.revokedAt))
  assert.equal(fake.uoaCredentials.size, 0)
})
