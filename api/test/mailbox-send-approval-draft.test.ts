import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import Fastify from 'fastify'

import { registerAgentEmailDraftRoutes } from '../src/routes/agent-email-draft.js'

const APPROVAL_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const PINNED_USER_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_OWNER_ID = '44444444-4444-4444-8444-444444444444'
const CONNECTION_ID = '55555555-5555-4555-8555-555555555555'

const context = (actorId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    actor: { actorId, actorType: 'user', roles },
    actionContext: { requestId: 'mailbox-send-approval-draft-test' },
    tenant: { organizationId: ORGANIZATION_ID },
  }) as AuthorizedActionContext

const makeApp = (actorId: string, roles: string[] = []) => {
  const prisma = {
    approvalRequest: {
      findFirst: async () => ({
        context: { mailboxConnectionId: CONNECTION_ID },
        expiresAt: new Date('2036-01-01T00:00:00Z'),
        id: APPROVAL_ID,
        requiredApproverUserId: PINNED_USER_ID,
        resumeState: {
          args: {
            bcc: ['hidden@example.test'],
            cc: ['copy@example.test'],
            subject: 'A complete subject',
            text: 'The complete body that must be read before it is sent.',
            to: ['recipient@example.test'],
          },
        },
        status: 'pending',
      }),
    },
    mailboxConnection: {
      findFirst: async () => ({ address: 'support@example.test' }),
    },
  } as unknown as PrismaClient
  const app = Fastify()
  registerAgentEmailDraftRoutes(app, {
    prisma,
    requireActorContext: () => context(actorId, roles),
  } as never)
  return app
}

test('the pinned mailbox approver receives every frozen recipient and body field', async () => {
  const app = makeApp(PINNED_USER_ID)
  await app.ready()
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/mailbox-connections/approvals/${APPROVAL_ID}/draft`,
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data, {
      approvalId: APPROVAL_ID,
      bcc: ['hidden@example.test'],
      cc: ['copy@example.test'],
      expiresAt: '2036-01-01T00:00:00.000Z',
      externalDisclosureSources: [],
      mailboxAddress: 'support@example.test',
      status: 'pending',
      subject: 'A complete subject',
      text: 'The complete body that must be read before it is sent.',
      to: ['recipient@example.test'],
    })
  } finally {
    await app.close()
  }
})

test('an organization owner who is not pinned cannot read the mailbox draft', async () => {
  const app = makeApp(OTHER_OWNER_ID, ['owner'])
  await app.ready()
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/mailbox-connections/approvals/${APPROVAL_ID}/draft`,
    })
    assert.equal(response.statusCode, 404, response.body)
  } finally {
    await app.close()
  }
})

test('private preview responses are no-store, including an absent approval', async () => {
  const app = makeApp(PINNED_USER_ID)
  await app.ready()
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/mailbox-connections/approvals/${APPROVAL_ID}/draft`,
    })
    assert.equal(response.headers['cache-control'], 'private, no-store')
  } finally {
    await app.close()
  }
})
