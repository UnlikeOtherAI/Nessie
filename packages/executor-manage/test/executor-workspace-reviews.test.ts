import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { deriveSecretKey, encryptWithKey } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { listExecutorWorkspaceReviews } from '../src/index.js'

const executorId = '00000000-0000-4000-8000-000000000101'
const organizationId = '00000000-0000-4000-8000-000000000102'
const userId = '00000000-0000-4000-8000-000000000103'
const commandId = '00000000-0000-4000-8000-000000000104'
const secret = 'workspace-review-secret'

const actorContext = {
  actor: { actorId: userId, actorType: 'user' },
  tenant: { organizationId },
} as unknown as AuthorizedActionContext

const reviewResult = {
  changeCount: 1,
  changes: [{ byteCount: 12, kind: 'created', path: 'draft.txt' }],
  manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  success: true,
}

const encrypted = JSON.stringify(encryptWithKey(
  deriveSecretKey(secret),
  JSON.stringify(reviewResult),
))

test('executor managers can inspect bounded review receipts without draft content', async () => {
  const prisma = {
    executor: {
      findFirst: async () => ({
        authorizationRevision: 1,
        createdAt: new Date('2026-08-12T12:00:00.000Z'),
        id: executorId,
        label: 'Reviewable sandbox',
        lastSeenAt: null,
        machineKeyFingerprint: null,
        organizationId,
        pairingOwnerUserId: userId,
        platformFacts: {},
        profiles: ['workspace_sandbox'],
        projectId: null,
        scopeKind: 'private',
        status: 'online',
        statusDetail: null,
        updatedAt: new Date('2026-08-12T12:00:00.000Z'),
      }),
    },
    executorCommand: {
      findMany: async () => [{
        acknowledgedAt: new Date('2026-08-12T12:01:00.000Z'),
        binding: { runId: '00000000-0000-4000-8000-000000000105' },
        id: commandId,
      }],
      findUnique: async () => ({ resultCiphertext: encrypted, state: 'result_acknowledged' }),
    },
    executorPrivateAssignment: {
      findFirst: async () => ({ role: 'admin' }),
    },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
  } as unknown as PrismaClient

  const reviews = await listExecutorWorkspaceReviews(prisma, secret, actorContext, executorId)

  assert.deepEqual(reviews, [{
    acknowledgedAt: '2026-08-12T12:01:00.000Z',
    changes: reviewResult.changes,
    commandId,
    manifestDigest: reviewResult.manifestDigest,
    runId: '00000000-0000-4000-8000-000000000105',
  }])
  assert.equal(JSON.stringify(reviews).includes('draft content'), false)
})
