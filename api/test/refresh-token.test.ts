import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  consumeRefreshToken,
  hashRefreshToken,
  issueRefreshToken,
  REFRESH_TOKEN_REPLAY_GRACE_MS,
} from '../src/services/refresh-token.js'

type StoredRefreshToken = {
  id: string
  userId: string
  familyId: string
  sessionId: string
  providerId: string
  providerType: string
  tokenHash: string
  expiresAt: Date
  revokedAt: Date | null
  replacedById: string | null
  userAgent: string | null
  createdAt: Date
}

type CreateInput = {
  data: {
    id?: string
    userId: string
    familyId: string
    sessionId: string
    providerId: string
    providerType: string
    tokenHash: string
    expiresAt: Date
    userAgent?: string
  }
  select?: { id?: boolean }
}

type UpdateManyInput = {
  where: {
    id?: string
    familyId?: string
    revokedAt?: null
    replacedById?: null
  }
  data: {
    revokedAt?: Date
    replacedById?: string
  }
}

const cloneToken = (token: StoredRefreshToken): StoredRefreshToken => ({ ...token })

class FakeRefreshTokenPrisma {
  readonly records = new Map<string, StoredRefreshToken>()
  private nextId = 1

  readonly refreshToken = {
    create: async (input: CreateInput) => {
      if (this.findByHash(input.data.tokenHash)) {
        throw new Error('duplicate token hash')
      }
      const record: StoredRefreshToken = {
        id: input.data.id ?? `token-${this.nextId++}`,
        userId: input.data.userId,
        familyId: input.data.familyId,
        sessionId: input.data.sessionId,
        providerId: input.data.providerId,
        providerType: input.data.providerType,
        tokenHash: input.data.tokenHash,
        expiresAt: input.data.expiresAt,
        revokedAt: null,
        replacedById: null,
        userAgent: input.data.userAgent ?? null,
        createdAt: new Date(),
      }
      this.records.set(record.id, record)
      return input.select ? { id: record.id } : cloneToken(record)
    },
    findUnique: async (input: { where: { id?: string; tokenHash?: string } }) => {
      const record = input.where.id
        ? this.records.get(input.where.id)
        : input.where.tokenHash
          ? this.findByHash(input.where.tokenHash)
          : undefined
      return record ? cloneToken(record) : null
    },
    updateMany: async (input: UpdateManyInput) => {
      let count = 0
      for (const record of this.records.values()) {
        if (input.where.id && record.id !== input.where.id) continue
        if (input.where.familyId && record.familyId !== input.where.familyId) continue
        if ('revokedAt' in input.where && record.revokedAt !== input.where.revokedAt) continue
        if ('replacedById' in input.where && record.replacedById !== input.where.replacedById) continue
        if (input.data.revokedAt) record.revokedAt = input.data.revokedAt
        if (input.data.replacedById) record.replacedById = input.data.replacedById
        count += 1
      }
      return { count }
    },
  }

  async $transaction<T>(operation: (tx: PrismaClient) => Promise<T>): Promise<T> {
    const snapshot = new Map(
      Array.from(this.records.entries()).map(([id, record]) => [id, cloneToken(record)]),
    )
    try {
      return await operation(this as unknown as PrismaClient)
    } catch (error) {
      this.records.clear()
      for (const [id, record] of snapshot) {
        this.records.set(id, record)
      }
      throw error
    }
  }

  findByHash(tokenHash: string): StoredRefreshToken | undefined {
    return Array.from(this.records.values()).find((record) => record.tokenHash === tokenHash)
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient
  }
}

const AUTH_SECRET = 'refresh-token-test-secret'
const TTL_SECONDS = 60 * 60
const USER_ID = '00000000-0000-4000-8000-000000000001'
const SESSION_ID = '00000000-0000-4000-8000-000000000002'

const createFixture = async () => {
  const fake = new FakeRefreshTokenPrisma()
  const initial = await issueRefreshToken(fake.asClient(), {
    userId: USER_ID,
    sessionId: SESSION_ID,
    providerId: 'uoa',
    providerType: 'uoa',
    ttlSeconds: TTL_SECONDS,
    userAgent: 'Nessie test',
  })
  return { fake, rawToken: initial.rawToken }
}

const consume = (
  fake: FakeRefreshTokenPrisma,
  rawToken: string,
  now: Date,
) => consumeRefreshToken(fake.asClient(), {
  authSecret: AUTH_SECRET,
  rawToken,
  ttlSeconds: TTL_SECONDS,
  userAgent: 'Nessie test',
  now,
})

test('active refresh atomically rotates to one hash-only deterministic successor', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  const result = await consume(fake, rawToken, now)

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.replayed, false)
  assert.notEqual(result.rawToken, rawToken)
  assert.equal(fake.records.size, 2)

  const predecessor = fake.findByHash(hashRefreshToken(rawToken))
  const successor = fake.findByHash(hashRefreshToken(result.rawToken))
  assert.equal(predecessor?.revokedAt, now)
  assert.equal(predecessor?.replacedById, successor?.id)
  assert.equal(successor?.revokedAt, null)
  assert.equal('rawToken' in (successor ?? {}), false)
})

test('simultaneous refreshes converge on the same successor without revoking the family', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()

  const [left, right] = await Promise.all([
    consume(fake, rawToken, now),
    consume(fake, rawToken, now),
  ])

  assert.equal(left.ok, true)
  assert.equal(right.ok, true)
  if (!left.ok || !right.ok) return
  assert.equal(left.rawToken, right.rawToken)
  assert.deepEqual([left.replayed, right.replayed].sort(), [false, true])
  assert.equal(fake.records.size, 2)
  assert.equal(
    Array.from(fake.records.values()).filter((record) => !record.revokedAt).length,
    1,
  )
})

test('same predecessor replay inside grace reissues its live successor', async () => {
  const { fake, rawToken } = await createFixture()
  const now = new Date()
  const rotated = await consume(fake, rawToken, now)
  assert.equal(rotated.ok, true)
  if (!rotated.ok) return

  const replay = await consume(fake, rawToken, new Date(now.getTime() + 1_000))

  assert.equal(replay.ok, true)
  if (!replay.ok) return
  assert.equal(replay.replayed, true)
  assert.equal(replay.rawToken, rotated.rawToken)
  assert.equal(fake.findByHash(hashRefreshToken(rotated.rawToken))?.revokedAt, null)
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
  assert.equal(fake.findByHash(hashRefreshToken(second.rawToken))?.revokedAt, null)
})

test('predecessor replay after grace revokes the current family', async () => {
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
})
