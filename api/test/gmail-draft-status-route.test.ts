import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerGmailDraftRoutes } from '../src/routes/gmail-drafts.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const draftId = '33333333-3333-4333-8333-333333333333'
const connectionId = '44444444-4444-4444-8444-444444444444'

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

test('a standing Gmail grant can come only from the pending frozen Gmail send it previews', async () => {
  let approvalWhere: unknown
  let actionWhere: unknown
  let grantConnectionId: string | undefined
  const app = Fastify()
  const prisma = {
    approvalRequest: { findFirst: async (input: { where: unknown }) => {
      approvalWhere = input.where
      return {
        agentId: '55555555-5555-4555-8555-555555555555',
        resumeState: { args: {
          connectionId, draftId, expectedFingerprint: 'f'.repeat(64),
          reviewed: { bcc: [], body: 'Reviewed', cc: [], subject: 'Subject', to: ['to@example.test'] },
        }, actorContext: { actor: { actorId: userId } }, interactive: true, messageId: 'message-1' },
      }
    } },
    gmailDraftAction: { findFirst: async (input: { where: unknown }) => {
      actionWhere = input.where
      return { connectionId }
    } },
    sendAuthorizationGrant: { upsert: async (input: { create: { connectionId: string } }) => {
      grantConnectionId = input.create.connectionId
      return { expiresAt: null, id: '66666666-6666-4666-8666-666666666666' }
    } },
  } as unknown as PrismaClient
  registerGmailDraftRoutes(app, { authSecret: 'test-secret', prisma, requireActorContext: () => actorContext } as never)
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/gmail/send-grants/from-approval',
      payload: { approvalId: draftId, duration: '30d' },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.match(JSON.stringify(approvalWhere), /gmail_draft_send/)
    assert.match(JSON.stringify(approvalWhere), /pending/)
    assert.match(JSON.stringify(approvalWhere), /expiresAt/)
    assert.match(JSON.stringify(actionWhere), new RegExp(connectionId))
    assert.equal(grantConnectionId, connectionId)
  } finally { await app.close() }
})

test('grant-from-approval rejects every approval that is not the live pinned Gmail send', async () => {
  for (const patch of [
    { status: 'approved', toolName: 'gmail_draft_send' },
    { status: 'pending', toolName: 'mailbox_send' },
    { status: 'pending', toolName: 'gmail_draft_send', expiresAt: new Date('2000-01-01T00:00:00.000Z') },
    { requiredApproverUserId: '77777777-7777-4777-8777-777777777777', status: 'pending', toolName: 'gmail_draft_send' },
  ]) {
    const app = Fastify()
    const prisma = {
      approvalRequest: { findFirst: async (input: { where: Record<string, unknown> }) => {
        const where = input.where
        const rejected = where.status !== patch.status
          || where.toolName !== patch.toolName
          || (patch.requiredApproverUserId && where.requiredApproverUserId !== patch.requiredApproverUserId)
          || Boolean(patch.expiresAt)
        return rejected ? null : { agentId: userId, resumeState: { args: {} } }
      } },
    } as unknown as PrismaClient
    registerGmailDraftRoutes(app, { authSecret: 'test-secret', prisma, requireActorContext: () => actorContext } as never)
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/gmail/send-grants/from-approval',
        payload: { approvalId: draftId, duration: '30d' },
      })
      assert.equal(response.statusCode, 404, response.body)
    } finally { await app.close() }
  }
})
