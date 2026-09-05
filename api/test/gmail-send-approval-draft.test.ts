import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerAgentEmailDraftRoutes } from '../src/routes/agent-email-draft.js'

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-822222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTION_ID = '55555555-5555-4555-8555-555555555555'

const actorContext = (actorId = USER_ID): AuthorizedActionContext => ({
  actor: { actorId, actorType: 'user', roles: [] },
  actionContext: { requestId: 'gmail-approval-preview-test' },
  tenant: { organizationId: ORGANIZATION_ID },
}) as AuthorizedActionContext

const makeApp = (actorId = USER_ID, active = true) => {
  const prisma = {
    approvalRequest: { findFirst: async () => active ? {
      context: { externalDisclosureSources: ['user:private-source'] },
      expiresAt: new Date('2036-01-01T00:00:00Z'), id: APPROVAL_ID,
      requiredApproverUserId: USER_ID,
      resumeState: { args: {
        connectionId: CONNECTION_ID, draftId: DRAFT_ID, expectedFingerprint: 'f'.repeat(64),
        reviewed: {
          bcc: ['hidden@example.test'], body: 'Exact reviewed body', cc: ['copy@example.test'],
          subject: 'Exact reviewed subject', to: ['recipient@example.test'],
        },
      } }, status: 'pending',
    } : null },
    gmailDraftAction: { findFirst: async () => ({
      connection: { externalUserId: 'sender@example.test' }, id: DRAFT_ID,
    }) },
  } as unknown as PrismaClient
  const app = Fastify()
  registerAgentEmailDraftRoutes(app, { prisma, requireActorContext: () => actorContext(actorId) } as never)
  return app
}

test('Gmail preview is exact, pinned, and private', async () => {
  const app = makeApp()
  await app.ready()
  try {
    const response = await app.inject({ method: 'GET', url: `/api/gmail/drafts/approvals/${APPROVAL_ID}/draft` })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    assert.deepEqual(response.json().data, {
      approvalId: APPROVAL_ID, bcc: ['hidden@example.test'], cc: ['copy@example.test'],
      expiresAt: '2036-01-01T00:00:00.000Z', externalDisclosureSources: ['user:private-source'],
      mailboxAddress: 'sender@example.test', status: 'pending', subject: 'Exact reviewed subject',
      text: 'Exact reviewed body', to: ['recipient@example.test'],
    })
  } finally { await app.close() }
})

test('Gmail preview is indistinguishable to an unpinned or inactive approval', async () => {
  for (const app of [makeApp('66666666-6666-4666-8666-666666666666'), makeApp(USER_ID, false)]) {
    await app.ready()
    try {
      const response = await app.inject({ method: 'GET', url: `/api/gmail/drafts/approvals/${APPROVAL_ID}/draft` })
      assert.equal(response.statusCode, 404, response.body)
      assert.equal(response.headers['cache-control'], 'private, no-store')
    } finally { await app.close() }
  }
})
