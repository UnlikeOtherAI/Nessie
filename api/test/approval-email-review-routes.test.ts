import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  projectEmailReviewAttachments,
  registerApprovalEmailReviewRoutes,
} from '../src/routes/approval-email-review.js'
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
  agentId: '00000000-0000-4000-8000-000000000107',
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

const pendingAgentApproval = {
  agentId: '00000000-0000-4000-8000-000000000107',
  expiresAt: new Date(Date.now() + 60_000),
  id: ids.approval,
  resumeState: {
    args: {
      text: 'The exact hosted-mail body.',
      approvalProposal: {
        bcc: ['audit@example.com'],
        cc: ['copy@example.com'],
        conversationId: null,
        mailboxId: ids.connection,
        subject: 'Private hosted update',
        to: ['customer@example.com'],
      },
    },
  },
  toolName: 'email_send',
}

const makeApp = (input: {
  actorId: string
  kind?: 'agent' | 'mailbox'
  status?: 'approved' | 'pending'
}) => {
  let mailboxReads = 0
  const approval = input.kind === 'agent' ? pendingAgentApproval : pendingMailboxApproval
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
          && toolNames.includes(approval.toolName)
          ? approval
          : null
      },
    },
    agentMailbox: {
      findFirst: async () => {
        mailboxReads += 1
        return { address: 'support@example.com', displayName: 'Customer support' }
      },
    },
    mailboxConnection: {
      findFirst: async () => {
        mailboxReads += 1
        return { address: 'support@example.com', label: 'Customer support' }
      },
    },
    organizationMember: { count: async () => 1 },
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
  assert.equal(response.headers['cache-control'], 'private, no-store')
  const data = (response.json() as { data: Record<string, unknown> }).data
  assert.deepEqual(data['to'], ['customer@example.com'])
  assert.equal(data['subject'], 'Private customer update')
  assert.equal(data['text'], 'The exact private body.')
  assert.equal(data['mailboxLabel'], 'Customer support')
  assert.deepEqual(data['attachments'], [])
  assert.equal('connectionId' in data, false)
  await own.app.close()

  const outsider = makeApp({ actorId: ids.outsider })
  const denied = await outsider.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(denied.statusCode, 404)
  assert.equal(denied.headers['cache-control'], 'private, no-store')
  assert.equal(outsider.mailboxReads(), 0)
  await outsider.app.close()
})

test('only the exact active approver can materialize a pending hosted-mail proposal', async () => {
  const own = makeApp({ actorId: ids.approver, kind: 'agent' })
  const response = await own.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'private, no-store')
  const data = (response.json() as { data: Record<string, unknown> }).data
  assert.equal(data['kind'], 'agent')
  assert.deepEqual(data['to'], ['customer@example.com'])
  assert.deepEqual(data['cc'], ['copy@example.com'])
  assert.deepEqual(data['bcc'], ['audit@example.com'])
  assert.equal(data['subject'], 'Private hosted update')
  assert.equal(data['text'], 'The exact hosted-mail body.')
  assert.deepEqual(data['attachments'], [])
  assert.equal('mailboxId' in data, false)
  await own.app.close()

  const outsider = makeApp({ actorId: ids.outsider, kind: 'agent' })
  const denied = await outsider.app.inject({
    method: 'GET',
    url: `/api/approvals/${ids.approval}/email-review`,
  })
  assert.equal(denied.statusCode, 404)
  assert.equal(denied.headers['cache-control'], 'private, no-store')
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

test('email review attachment projection excludes every provider identity', () => {
  const attachments = projectEmailReviewAttachments([{
    attachmentId: 'provider-private-attachment-id',
    filename: 'plan.pdf',
    inlineDataHash: 'provider-private-inline-hash',
    mimeType: 'application/pdf',
    sizeBytes: 42,
  }])
  assert.deepEqual(attachments, [{
    filename: 'plan.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42,
  }])
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
