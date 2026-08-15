import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  isSessionTokenRevoked,
  issueSessionToken,
  verifySessionToken,
} from '../src/auth/session.js'
import { revokeRefreshTokenByRaw } from '../src/services/refresh-token.js'

const SECRET = 'test-secret'
const BASE = {
  org: '00000000-0000-4000-8000-000000000001',
  proj: '00000000-0000-4000-8000-000000000002',
  providerId: 'local',
  providerType: 'local-bootstrap' as const,
  roles: ['member'],
  sub: '00000000-0000-4000-8000-000000000003',
  team: '00000000-0000-4000-8000-000000000004',
}

test('the revocation generation survives issue and verify', () => {
  const { token } = issueSessionToken({ ...BASE, tv: 3 }, SECRET, 60)
  const result = verifySessionToken(token, SECRET)
  assert.ok(result.ok)
  assert.equal(result.claims.tv, 3)
})

test('a token minted at the current generation is accepted', () => {
  const { token } = issueSessionToken({ ...BASE, tv: 4 }, SECRET, 60)
  const result = verifySessionToken(token, SECRET)
  assert.ok(result.ok)
  assert.equal(isSessionTokenRevoked(result.claims, 4), false)
})

test('a token minted before user-wide revocation is rejected before expiry', () => {
  // User-wide revocation bumps User.tokenVersion 0 -> 1. The access token is still
  // cryptographically valid and unexpired, which is exactly the window that
  // revoking only the refresh family left open.
  const { token } = issueSessionToken({ ...BASE, tv: 0 }, SECRET, 3600)
  const result = verifySessionToken(token, SECRET)
  assert.ok(result.ok)
  assert.equal(isSessionTokenRevoked(result.claims, 1), true)
})

test('a token predating the tv claim reads as generation zero', () => {
  // Tokens issued before this change carry no `tv`, and the column defaults to
  // 0, so existing sessions keep working until something actually revokes them.
  const { token } = issueSessionToken(BASE, SECRET, 60)
  const result = verifySessionToken(token, SECRET)
  assert.ok(result.ok)
  assert.equal(result.claims.tv, undefined)
  assert.equal(isSessionTokenRevoked(result.claims, 0), false)
  assert.equal(isSessionTokenRevoked(result.claims, 1), true)
})

// ─── Raw refresh-family revocation reports its owner ────────────────────────

const makePrisma = (
  rows: Array<{ tokenHash: string; familyId: string; userId: string }>,
): { prisma: PrismaClient; revokedFamilies: string[] } => {
  const revokedFamilies: string[] = []
  const prisma = {
    refreshToken: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        rows.find((row) => row.tokenHash === where.tokenHash) ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The family revoke takes a Postgres advisory lock first.
        $queryRaw: async () => [{ locked: true }],
        refreshToken: {
          updateMany: async ({ where }: { where: { familyId: string } }) => {
            revokedFamilies.push(where.familyId)
            return { count: 1 }
          },
        },
        uoaSessionCredential: { deleteMany: async () => ({ count: 0 }) },
      }),
  } as unknown as PrismaClient
  return { prisma, revokedFamilies }
}

test('raw family revocation reports the owning user', async () => {
  const { createHash } = await import('node:crypto')
  const raw = 'refresh-token-value'
  const tokenHash = createHash('sha256').update(raw).digest('hex')
  const { prisma } = makePrisma([
    { tokenHash, familyId: 'family-1', userId: BASE.sub },
  ])

  const result = await revokeRefreshTokenByRaw(prisma, raw)
  assert.deepEqual(result, { userId: BASE.sub })
})

test('raw family revocation with an unknown token stays a no-op', async () => {
  const { prisma } = makePrisma([])
  assert.equal(await revokeRefreshTokenByRaw(prisma, 'nope'), null)
})
