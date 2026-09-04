import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerGmailDraftRoutes } from '../src/routes/gmail-drafts.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const draftId = '33333333-3333-4333-8333-333333333333'

const actorContext: AuthorizedActionContext = {
  actionContext: { requestId: 'gmail-draft-status-test' },
  actor: { actorId: userId, actorType: 'user', roles: ['member'] },
  tenant: { organizationId },
}

test('the owner-only Gmail action status exposes no message content', async () => {
  let where: unknown
  const app = Fastify()
  const prisma = {
    gmailDraftAction: {
      findFirst: async (input: { where: unknown }) => {
        where = input.where
        return {
          id: draftId,
          sendAfter: new Date('2026-09-04T10:00:15.000Z'),
          state: 'sending',
        }
      },
    },
  } as unknown as PrismaClient
  registerGmailDraftRoutes(app, {
    authSecret: 'test-secret',
    prisma,
    requireActorContext: () => actorContext,
  } as never)
  try {
    const response = await app.inject({ method: 'GET', url: `/api/gmail/drafts/${draftId}/status` })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    assert.deepEqual(response.json().data, {
      id: draftId,
      sendAfter: '2026-09-04T10:00:15.000Z',
      state: 'sending',
    })
    assert.deepEqual(where, { id: draftId, organizationId, ownerUserId: userId })
    assert.doesNotMatch(response.body, /body|subject|recipient|fingerprint/i)
  } finally {
    await app.close()
  }
})
