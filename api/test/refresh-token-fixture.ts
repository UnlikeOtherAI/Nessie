import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  consumeRefreshToken,
  hashRefreshToken,
  issueRefreshToken,
} from '../src/services/refresh-token.js'

export type StoredRefreshToken = {
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
  replayProtectedUntil: Date | null
  userAgent: string | null
  createdAt: Date
}

type StoredUoaCredential = {
  familyId: string
  userId: string
  providerId: string
  subject: string
  organizationId: string
  teamId: string
  tokenVersion: number
  configUrl: string
  refreshTokenHash: string
  refreshTokenCiphertext: string
  refreshTokenIv: string
  refreshTokenAuthTag: string
  refreshTokenExpiresAt: Date
  lastLocalTokenId: string
  generation: number
  createdAt: Date
  updatedAt: Date
}

type RefreshCreateInput = {
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

type RefreshUpdateManyInput = {
  where: {
    id?: string
    familyId?: string
    revokedAt?: null
    replacedById?: null
  }
  data: {
    revokedAt?: Date
    replacedById?: string
    replayProtectedUntil?: Date
  }
}

type UoaCreateInput = {
  data: Omit<StoredUoaCredential, 'createdAt' | 'generation' | 'updatedAt'>
}

type UoaUpdateManyInput = {
  where: Pick<
    StoredUoaCredential,
    'familyId' | 'generation' | 'lastLocalTokenId' | 'refreshTokenHash'
  >
  data: Partial<Omit<StoredUoaCredential, 'generation'>> & {
    generation?: { increment: number }
  }
}

const cloneToken = (token: StoredRefreshToken): StoredRefreshToken => ({ ...token })
const cloneCredential = (
  credential: StoredUoaCredential,
): StoredUoaCredential => ({ ...credential })

export class FakeRefreshTokenPrisma {
  readonly records = new Map<string, StoredRefreshToken>()
  readonly uoaCredentials = new Map<string, StoredUoaCredential>()
  failNextTransaction = false
  activeTransactions = 0
  private nextId = 1
  private transactionTail: Promise<void> = Promise.resolve()

  readonly refreshToken = {
    create: async (input: RefreshCreateInput) => {
      if (this.findByHash(input.data.tokenHash)) throw new Error('duplicate token hash')
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
        replayProtectedUntil: null,
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
    updateMany: async (input: RefreshUpdateManyInput) => {
      let count = 0
      for (const record of this.records.values()) {
        if (input.where.id && record.id !== input.where.id) continue
        if (input.where.familyId && record.familyId !== input.where.familyId) continue
        if ('revokedAt' in input.where && record.revokedAt !== input.where.revokedAt) continue
        if ('replacedById' in input.where && record.replacedById !== input.where.replacedById) continue
        if (input.data.revokedAt) record.revokedAt = input.data.revokedAt
        if (input.data.replacedById) record.replacedById = input.data.replacedById
        if (input.data.replayProtectedUntil) {
          record.replayProtectedUntil = input.data.replayProtectedUntil
        }
        count += 1
      }
      return { count }
    },
  }

  readonly uoaSessionCredential = {
    create: async (input: UoaCreateInput) => {
      if (this.uoaCredentials.has(input.data.familyId)) {
        throw new Error('duplicate UOA family')
      }
      const now = new Date()
      const record: StoredUoaCredential = {
        ...input.data,
        generation: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.uoaCredentials.set(record.familyId, record)
      return cloneCredential(record)
    },
    findUnique: async (input: { where: { familyId: string } }) => {
      const record = this.uoaCredentials.get(input.where.familyId)
      return record ? cloneCredential(record) : null
    },
    updateMany: async (input: UoaUpdateManyInput) => {
      const record = this.uoaCredentials.get(input.where.familyId)
      if (
        !record
        || record.generation !== input.where.generation
        || record.lastLocalTokenId !== input.where.lastLocalTokenId
        || record.refreshTokenHash !== input.where.refreshTokenHash
      ) return { count: 0 }
      Object.assign(record, input.data, {
        generation: record.generation + (input.data.generation?.increment ?? 0),
        updatedAt: new Date(),
      })
      return { count: 1 }
    },
    deleteMany: async (input: {
      where: { familyId: string | { in: string[] } }
    }) => {
      const familyIds = typeof input.where.familyId === 'string'
        ? [input.where.familyId]
        : input.where.familyId.in
      let count = 0
      for (const familyId of familyIds) {
        if (this.uoaCredentials.delete(familyId)) count += 1
      }
      return { count }
    },
  }

  readonly user = { findFirst: async () => ({ passwordHash: null }) }

  async $transaction<T>(operation: (tx: PrismaClient) => Promise<T>): Promise<T> {
    let release!: () => void
    const prior = this.transactionTail
    this.transactionTail = new Promise<void>((resolve) => { release = resolve })
    await prior
    this.activeTransactions += 1
    const tokenSnapshot = new Map(
      Array.from(this.records.entries()).map(([id, record]) => [id, cloneToken(record)]),
    )
    const credentialSnapshot = new Map(
      Array.from(this.uoaCredentials.entries()).map(
        ([id, record]) => [id, cloneCredential(record)],
      ),
    )
    try {
      const failAfterOperation = this.failNextTransaction
      this.failNextTransaction = false
      const result = await operation(this as unknown as PrismaClient)
      if (failAfterOperation) throw new Error('simulated local commit failure')
      return result
    } catch (error) {
      this.records.clear()
      this.uoaCredentials.clear()
      for (const [id, record] of tokenSnapshot) this.records.set(id, record)
      for (const [id, record] of credentialSnapshot) this.uoaCredentials.set(id, record)
      throw error
    } finally {
      this.activeTransactions -= 1
      release()
    }
  }

  async $queryRaw(): Promise<unknown[]> {
    return []
  }

  findByHash(tokenHash: string): StoredRefreshToken | undefined {
    return Array.from(this.records.values()).find(
      (record) => record.tokenHash === tokenHash,
    )
  }

  asClient(): PrismaClient {
    return this as unknown as PrismaClient
  }
}

export const AUTH_SECRET = 'refresh-token-test-secret'
export const TTL_SECONDS = 60 * 60
export const USER_ID = '00000000-0000-4000-8000-000000000001'
export const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000010'
export const SESSION_ID = '00000000-0000-4000-8000-000000000002'
export const UOA_CONFIG_URL = 'https://api.example.com/api/auth/sso/config'
export const UOA_IDENTITY = {
  organizationId: 'uoa-org',
  subject: 'uoa-user',
  teamId: 'uoa-team',
  tokenVersion: 7,
} as const satisfies UoaSessionIdentity

export const createRefreshFixture = async () => {
  const fake = new FakeRefreshTokenPrisma()
  const initial = await issueRefreshToken(fake.asClient(), {
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    sessionId: SESSION_ID,
    providerId: 'uoa',
    providerType: 'uoa',
    ttlSeconds: TTL_SECONDS,
    encryptionSecret: AUTH_SECRET,
    uoaSession: {
      configUrl: UOA_CONFIG_URL,
      identity: UOA_IDENTITY,
      refreshToken: 'uoa-refresh-1',
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    },
    userAgent: 'Nessie test',
  })
  return { fake, rawToken: initial.rawToken }
}

export type RefreshCallback = NonNullable<
  Parameters<typeof consumeRefreshToken>[1]['refreshUoaSession']
>

export const defaultUoaRefresh = (now: Date): RefreshCallback => async (input) => ({
  identity: input.expectedIdentity,
  refreshToken: `${input.refreshToken}.next`,
  refreshTokenExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
})

export const consume = (
  fake: FakeRefreshTokenPrisma,
  rawToken: string,
  now: Date,
  refreshUoaSession: RefreshCallback = defaultUoaRefresh(now),
) => consumeRefreshToken(fake.asClient(), {
  authSecret: AUTH_SECRET,
  advanceUoaSessionBinding: async () => undefined,
  rawToken,
  ttlSeconds: TTL_SECONDS,
  refreshUoaSession,
  userAgent: 'Nessie test',
  now,
})
