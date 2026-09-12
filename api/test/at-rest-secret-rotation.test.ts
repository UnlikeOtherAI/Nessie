import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AT_REST_SECRET_PURPOSE,
  decryptWithKeyRing,
  deriveSecretKey,
  encryptWithKey,
  encryptWithKeyRing,
} from '@nessie/runtime'

import {
  AtRestSecretRotationError,
  rotateDurableAtRestSecrets,
} from '../src/services/at-rest-secret-rotation.js'

const legacyRoot = 'legacy-root-for-rotation-tests'
const activeRoot = 'active-root-for-rotation-tests'
const ring = {
  activeVersion: '2026-09',
  keys: { '2026-09': activeRoot },
  legacyKey: legacyRoot,
} as const

const emptyFindMany = async () => []

const basePrisma = (
  uoaSessionCredential: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  boardSource: { findMany: emptyFindMany },
  boardSourceConnectionCredential: { findMany: emptyFindMany },
  cloudBrowserSession: { findMany: emptyFindMany },
  commsConnectionCredential: { findMany: emptyFindMany },
  executorCommand: { findMany: emptyFindMany },
  mailboxConnectionCredential: { findMany: emptyFindMany },
  mcpOAuthSecret: { findMany: emptyFindMany },
  productWebhookSecret: { findMany: emptyFindMany },
  uoaSessionCredential,
  ...overrides,
})

const legacyUoaRow = () => {
  const encrypted = encryptWithKey(deriveSecretKey(legacyRoot), 'refresh-token')
  return { familyId: 'family-a', ...{
    refreshTokenAuthTag: encrypted.authTag,
    refreshTokenCiphertext: encrypted.ciphertext,
    refreshTokenIv: encrypted.iv,
  } }
}

test('re-encrypts legacy UOA refresh credentials under the active version', async () => {
  const row = legacyUoaRow()
  let replacement: Record<string, string> | undefined
  const prisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) =>
      args.where?.familyId ? [] : [row],
    updateMany: async (args: { data: Record<string, string> }) => {
      replacement = args.data
      return { count: 1 }
    },
  })

  const result = await rotateDurableAtRestSecrets(prisma as never, ring)

  assert.deepEqual(result.uoa_session_credentials, { conflicts: 0, rotated: 1 })
  assert.ok(replacement)
  const opened = decryptWithKeyRing(ring, AT_REST_SECRET_PURPOSE.uoaRefresh, {
    authTag: replacement.refreshTokenAuthTag,
    ciphertext: replacement.refreshTokenCiphertext,
    iv: replacement.refreshTokenIv,
  })
  assert.equal(opened.plaintext, 'refresh-token')
  assert.equal(opened.keyVersion, ring.activeVersion)
})

test('re-encrypts a retained prior-version envelope under the active version', async () => {
  const rotationRing = {
    ...ring,
    keys: { '2026-06': 'prior-root-for-rotation-tests', ...ring.keys },
  }
  const priorWriteRing = {
    activeVersion: '2026-06',
    keys: rotationRing.keys,
    legacyKey: legacyRoot,
  }
  const prior = encryptWithKeyRing(
    priorWriteRing,
    AT_REST_SECRET_PURPOSE.uoaRefresh,
    'refresh-token',
  )
  const row = {
    familyId: 'family-old-version',
    refreshTokenAuthTag: prior.authTag,
    refreshTokenCiphertext: prior.ciphertext,
    refreshTokenIv: prior.iv,
  }
  let replacement: Record<string, string> | undefined
  const prisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) =>
      args.where?.familyId ? [] : [row],
    updateMany: async (args: { data: Record<string, string> }) => {
      replacement = args.data
      return { count: 1 }
    },
  })

  await rotateDurableAtRestSecrets(prisma as never, rotationRing)

  assert.ok(replacement)
  assert.equal(
    decryptWithKeyRing(rotationRing, AT_REST_SECRET_PURPOSE.uoaRefresh, {
      authTag: replacement.refreshTokenAuthTag,
      ciphertext: replacement.refreshTokenCiphertext,
      iv: replacement.refreshTokenIv,
    }).keyVersion,
    rotationRing.activeVersion,
  )
})

test('reports a CAS conflict and continues safely when a concurrent writer wins', async () => {
  const row = legacyUoaRow()
  const prisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) =>
      args.where?.familyId ? [] : [row],
    updateMany: async () => ({ count: 0 }),
  })

  const result = await rotateDurableAtRestSecrets(prisma as never, ring)

  assert.deepEqual(result.uoa_session_credentials, { conflicts: 1, rotated: 0 })
})

test('rerunning after a conflict converges once the competing write is finished', async () => {
  const row = legacyUoaRow()
  let competingWrite = true
  const prisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) =>
      args.where?.familyId ? [] : [row],
    updateMany: async () => {
      if (competingWrite) {
        competingWrite = false
        return { count: 0 }
      }
      return { count: 1 }
    },
  })

  const first = await rotateDurableAtRestSecrets(prisma as never, ring)
  const second = await rotateDurableAtRestSecrets(prisma as never, ring)

  assert.equal(first.uoa_session_credentials.conflicts, 1)
  assert.deepEqual(second.uoa_session_credentials, { conflicts: 0, rotated: 1 })
})

test('uses a monotonic keyset after a concurrent delete instead of a cursor', async () => {
  const row = legacyUoaRow()
  let deleted = false
  const prisma = basePrisma({
    findMany: async (args: { cursor?: unknown; where?: { familyId?: { gt: string } } }) => {
      assert.equal(args.cursor, undefined)
      if (args.where?.familyId?.gt === row.familyId) return []
      return deleted ? [] : [row]
    },
    updateMany: async () => {
      deleted = true
      return { count: 1 }
    },
  })

  const result = await rotateDurableAtRestSecrets(prisma as never, ring, { batchSize: 1 })

  assert.deepEqual(result.uoa_session_credentials, { conflicts: 0, rotated: 1 })
})

test('writes the active string version to every credential progress mirror', async () => {
  const packed = (plaintext: string) => {
    const encrypted = encryptWithKey(deriveSecretKey(legacyRoot), plaintext)
    return `${encrypted.iv}.${encrypted.authTag}.${encrypted.ciphertext}`
  }
  const board = { accessTokenCiphertext: packed('board-token'), id: 'board-a', refreshTokenCiphertext: null }
  const comms = { accessTokenCiphertext: packed('comms-token'), id: 'comms-a', refreshTokenCiphertext: null }
  const mailbox = { id: 'mailbox-a', secretCiphertext: packed('mailbox-password') }
  const written: Array<Record<string, unknown>> = []
  const page = <T extends { id: string }>(row: T) =>
    async (args: { where?: { id?: { gt: string } } }) => args.where?.id ? [] : [row]
  const prisma = basePrisma({ findMany: emptyFindMany }, {
    boardSourceConnectionCredential: {
      findMany: page(board),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        written.push(args.data)
        return { count: 1 }
      },
    },
    commsConnectionCredential: {
      findMany: page(comms),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        written.push(args.data)
        return { count: 1 }
      },
    },
    mailboxConnectionCredential: {
      findMany: page(mailbox),
      updateMany: async (args: { data: Record<string, unknown> }) => {
        written.push(args.data)
        return { count: 1 }
      },
    },
  })

  const result = await rotateDurableAtRestSecrets(prisma as never, ring)

  assert.deepEqual(
    written.map((data) => data.keyVersion),
    [ring.activeVersion, ring.activeVersion, ring.activeVersion],
  )
  assert.equal(result.board_source_connection_credentials.rotated, 1)
  assert.equal(result.comms_connection_credentials.rotated, 1)
  assert.equal(result.mailbox_connection_credentials.rotated, 1)
})

test('fails closed when a required root is missing or ciphertext belongs to another purpose', async () => {
  const missingLegacy = legacyUoaRow()
  const missingLegacyPrisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) =>
      args.where?.familyId ? [] : [missingLegacy],
    updateMany: async () => ({ count: 1 }),
  })
  await assert.rejects(
    rotateDurableAtRestSecrets(missingLegacyPrisma as never, {
      activeVersion: ring.activeVersion,
      keys: ring.keys,
    }),
    (error: unknown) => error instanceof AtRestSecretRotationError
      && error.message.includes('uoa_session_credentials'),
  )

  const wrongPurpose = encryptWithKeyRing(
    ring,
    AT_REST_SECRET_PURPOSE.pushCredential,
    'refresh-token',
  )
  const wrongPurposePrisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) => args.where?.familyId
      ? []
      : [{
          familyId: 'family-b',
          refreshTokenAuthTag: wrongPurpose.authTag,
          refreshTokenCiphertext: wrongPurpose.ciphertext,
          refreshTokenIv: wrongPurpose.iv,
        }],
    updateMany: async () => ({ count: 1 }),
  })
  await assert.rejects(
    rotateDurableAtRestSecrets(wrongPurposePrisma as never, ring),
    (error: unknown) => error instanceof AtRestSecretRotationError
      && error.message.includes('uoa_session_credentials'),
  )

  const oldEnvelope = encryptWithKeyRing(
    {
      activeVersion: '2026-06',
      keys: { '2026-06': 'retired-root-for-fail-closed-test' },
    },
    AT_REST_SECRET_PURPOSE.uoaRefresh,
    'refresh-token',
  )
  const missingVersionPrisma = basePrisma({
    findMany: async (args: { where?: { familyId?: { gt: string } } }) => args.where?.familyId
      ? []
      : [{
          familyId: 'family-c',
          refreshTokenAuthTag: oldEnvelope.authTag,
          refreshTokenCiphertext: oldEnvelope.ciphertext,
          refreshTokenIv: oldEnvelope.iv,
        }],
    updateMany: async () => ({ count: 1 }),
  })
  await assert.rejects(
    rotateDurableAtRestSecrets(missingVersionPrisma as never, ring),
    (error: unknown) => error instanceof AtRestSecretRotationError
      && error.message.includes('uoa_session_credentials'),
  )
})
