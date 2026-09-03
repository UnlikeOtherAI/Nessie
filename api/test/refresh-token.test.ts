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
  let callbackRanOutsideTransaction = false
  const refresh = defaultUoaRefresh(now)

  const result = await consume(fake, rawToken, now, async (input) => {
    callbackRanOutsideTransaction = fake.activeTransactions === 0
    return refresh(input)
  })

  assert.equal(result.ok, true)
  assert.equal(callbackRanOutsideTransaction, true)
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
  // Concurrent callers may both reach UOA; its exact-context replay contract
  // returns the same upstream successor and the local CAS persists it once.
  assert.equal(upstreamCalls, 2)
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
  let failCommit = true
  const countedRefresh: RefreshCallback = async (input) => {
    upstreamCalls += 1
    const result = await refresh(input)
    if (failCommit) {
      failCommit = false
      fake.failNextTransaction = true
    }
    return result
  }

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

test('ancestor replay adopts an in-flight UOA successor behind the local barrier', async () => {
  const { fake, rawToken: ancestorRawToken } = await createFixture()
  const now = new Date()
  const first = await consume(fake, ancestorRawToken, now)
  assert.equal(first.ok, true)
  if (!first.ok) return

  let releaseUpstream!: () => void
  let markEntered!: () => void
  const upstreamGate = new Promise<void>((resolve) => { releaseUpstream = resolve })
  const entered = new Promise<void>((resolve) => { markEntered = resolve })
  const refresh = defaultUoaRefresh(new Date(now.getTime() + 1_000))
  const currentRotation = consume(
    fake,
    first.rawToken,
    new Date(now.getTime() + 1_000),
    async (input) => {
      markEntered()
      await upstreamGate
      return refresh(input)
    },
  )
  await entered

  const ancestorReplay = await consume(
    fake,
    ancestorRawToken,
    new Date(now.getTime() + 2_000),
  )
  releaseUpstream()
  const current = await currentRotation

  assert.equal(ancestorReplay.ok, true)
  assert.equal(current.ok, true)
  if (!ancestorReplay.ok || !current.ok) return
  assert.equal(ancestorReplay.rawToken, first.rawToken)
  assert.equal(current.rawToken, first.rawToken)
  assert.equal(current.replayed, true)

  const credential = fake.uoaCredentials.get(current.familyId)
  const localCurrent = fake.findByHash(hashRefreshToken(first.rawToken))
  assert.equal(credential?.generation, 2)
  assert.equal(
    credential?.refreshTokenHash,
    hashRefreshToken('uoa-refresh-1.next.next'),
  )
  assert.equal(credential?.lastLocalTokenId, localCurrent?.id)

  const afterBarrier = await consume(
    fake,
    first.rawToken,
    new Date(now.getTime() + REFRESH_TOKEN_REPLAY_GRACE_MS + 3_000),
  )
  assert.equal(afterBarrier.ok, true)
  if (afterBarrier.ok) assert.notEqual(afterBarrier.rawToken, first.rawToken)
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
    advanceUoaSessionBinding: async () => undefined,
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

// Estate rule: a successor proving the same subject and a non-regressed epoch
// is adopted even when its team drifted, because a silent switch makes
// drift the ordinary way a committed switch reaches the next refresh.
test('adopts a UOA successor whose team drifted', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  const rotated = await consume(fake, rawToken, now, async (input) => ({
    identity: { ...input.expectedIdentity, teamId: 'different-team' },
    refreshToken: `${input.refreshToken}.next`,
    refreshTokenExpiresAt: new Date(now.getTime() + 60_000),
  }))

  assert.equal(rotated.ok, true)
  if (!rotated.ok) return
  assert.equal(rotated.uoaIdentity?.teamId, 'different-team')
  // The encrypted family proof follows the team UOA proved.
  assert.equal(fake.uoaCredentials.get(rotated.familyId)?.teamId, 'different-team')
})

// The two checks that actually prove identity are unchanged: either violation
// still refuses before any local rotation.
test('rejects a changed subject or a regressed epoch before any local rotation', async () => {
  for (const drift of [
    { subject: 'someone-else' },
    { tokenVersion: UOA_IDENTITY.tokenVersion - 1 },
  ]) {
    const { fake, rawToken } = await createFixture()
    const now = new Date()

    await assert.rejects(
      consume(fake, rawToken, now, async (input) => ({
        identity: { ...input.expectedIdentity, ...drift },
        refreshToken: `${input.refreshToken}.next`,
        refreshTokenExpiresAt: new Date(now.getTime() + 60_000),
      })),
      UoaRefreshBindingError,
    )
    assert.equal(fake.findByHash(hashRefreshToken(rawToken))?.revokedAt, null)
    assert.equal(fake.uoaCredentials.size, 1)
  }
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
