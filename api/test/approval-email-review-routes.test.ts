import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerApprovalEmailReviewRoutes } from '../src/routes/approval-email-review.js'
import { approvalResolutionScopes } from '../src/routes/approvals.js'
import type { RouteDeps } from '../src/routes/types.js'

const ids = {
  approval: '00000000-0000-4000-8000-000000000101',
  approver: '00000000-0000-4000-8000-000000000102',
  channel: '00000000-0000-4000-8000-000000000103',
  connection: '00000000-0000-4000-8000-000000000104',
  organization: '00000000-0000-4000-8000-000000000105',
  outsider: '00000000-0000-4000-8000-000000000106',
} as const

const actorContext = (userId: string): AuthorizedActionContext => ({
  actionContext: { requestId: 'approval-email-review-test' },
  actor: { actorId: userId, actorType: 'user', roles: ['owner'] },
  tenant: { organizationId: ids.organization },
}) as unknown as AuthorizedActionContext

const pendingMailboxApproval = {
  expiresAt: new Date(Date.now() + 60_000),
  id: ids.approval,
  resumeState: {
    args: {
      bcc: ['audit@example.com'],
      cc: ['copy@example.com'],
      connectionId: ids.connection,
      subject: 'Private customer update',
      text: 'The exact private body.',
      to: ['customer@example.com'],
    },
  },
  toolName: 'mailbox_send',
}

const makeApp = (input: { actorId: string; status?: 'approved' | 'pending' }) => {
  let mailboxReads = 0
  const app = Fastify({ logger: false })
  app.decorateRequest('actorContext', null)
  app.addHook('onRequest', (request, _reply, done) => {
    ;(request as { actorContext: AuthorizedActionContext }).actorContext = actorContext(input.actorId)
    done()
  })

  const prisma = {
    approvalRequest: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const toolNames = (where['toolName'] as { in?: string[] } | undefined)?.in ?? []
        return where['id'] === ids.approval
          && where['organizationId'] === ids.organization
          && where['requiredApproverUserId'] === ids.approver
          && where['status'] === (input.status ?? 'pending')
          && toolNames.includes('mailbox_send')
          ? pendingMailboxApproval
          : null
      },
    },
    mailboxConnection: {
      findFirst: async () => {
        mailboxReads += 1
        return { address: 'support@example.com', label: 'Customer support' }
      },
    },
  }

  const deps = {
    authSecret: 'test-secret',
    prisma,
    requireActorContext: (request: { actorContext?: AuthorizedActionContext | null }) =>
      request.actorContext ?? null,
  } as unknown as RouteDeps
  registerApprovalEmailReviewRoutes(app, deps)
  return { app, mailboxReads: () => mailboxReads }
}

test('only the exact approver can materialize a pending mailbox email proposal', async () => {
  const own = makeApp({ actorId: ids.approver })
  const response = await own.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(response.statusCode, 200)
  const data = (response.json() as { data: Record<string, unknown> }).data
  assert.deepEqual(data['to'], ['customer@example.com'])
  assert.equal(data['subject'], 'Private customer update')
  assert.equal(data['text'], 'The exact private body.')
  assert.equal(data['mailboxLabel'], 'Customer support')
  assert.equal('connectionId' in data, false)
  await own.app.close()

  const outsider = makeApp({ actorId: ids.outsider })
  const denied = await outsider.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(denied.statusCode, 404)
  assert.equal(outsider.mailboxReads(), 0)
  await outsider.app.close()
})

test('email review ends with its pending approval', async () => {
  const resolved = makeApp({ actorId: ids.approver, status: 'approved' })
  const response = await resolved.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(response.statusCode, 404)
  assert.equal(resolved.mailboxReads(), 0)
  await resolved.app.close()
})

test('a pinned approval resolution targets only its designated user', () => {
  assert.deepEqual(
    approvalResolutionScopes({
      channelId: ids.channel,
      organizationId: ids.organization,
      requiredApproverUserId: ids.approver,
    }),
    [{ kind: 'user', organizationId: ids.organization, userId: ids.approver }],
  )
})
