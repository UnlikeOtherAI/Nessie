import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { mintJudgedGmailDraftAuthorization, type JudgedGmailDraftAuthorization } from '@nessie/team-admin'

import { authorizeGmailDraftDispatch, runGmailDraftSendTool } from './gmail-send-tool.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  draft: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
} as const

const context = (input: {
  approval?: { approvalId?: string; approvalProof?: string }
  authorization?: { judgedGmailDraftAuthorization?: JudgedGmailDraftAuthorization }
  grant: {
    boundary?: string | null
    expiresAt: Date | null
    id?: string
    mode?: 'always' | 'judged'
    revokedAt: Date | null
  } | null
}): BuiltinToolRuntimeContext => ({
  agentId: ids.agent,
  agentKind: 'personal_assistant',
  actorContext: {
    actionContext: { effectiveUserId: parseUserId(ids.user), requestId: 'gmail-send-tool-test' },
    actor: { actorId: ids.user, actorType: 'user', roles: ['member'] },
    ...(input.approval ? { approval: input.approval } : {}),
    tenant: { organizationId: parseOrganizationId(ids.organization) },
  } as AuthorizedActionContext,
  ...(input.authorization ? { authorization: input.authorization } : {}),
  channel: { id: ids.draft, organizationId: parseOrganizationId(ids.organization) },
  ledgerIdentity: null,
  prisma: {
    commsConnection: { findFirst: async () => ({ ownerUserId: ids.user }) },
    gmailDraftAction: {
      findFirst: async () => ({
        connectionId: '55555555-5555-4555-8555-555555555555',
        id: ids.draft,
        ownerUserId: ids.user,
        state: 'draft',
      }),
    },
    sendAuthorizationGrant: {
      findUnique: async () => input.grant
        ? {
            expiresAt: input.grant.expiresAt,
            id: input.grant.id ?? 'grant-1',
            mode: input.grant.mode ?? 'always',
            revokedAt: input.grant.revokedAt,
            boundary: input.grant.boundary ?? null,
          }
        : null,
    },
  } as unknown as PrismaClient,
  realtimeTransport: { publishWs: async () => undefined } as never,
  run: { id: 'run-1', messageId: 'message-1', threadId: ids.draft },
  toolCallId: 'tool-call-1',
})

const args = { approvalFingerprint: 'a'.repeat(64), draftId: ids.draft }

test('a raw approval proof is never treated as an approved Gmail send', async () => {
  await assert.rejects(
    runGmailDraftSendTool(context({
      approval: { approvalId: 'approval-1', approvalProof: 'wrong-tool-proof' },
      grant: { expiresAt: null, revokedAt: null },
    }), args),
    /need approval/i,
  )
})

test('ordinary standing consent is rechecked and denies a revoked grant', async () => {
  await assert.rejects(
    runGmailDraftSendTool(context({
      grant: { expiresAt: null, revokedAt: new Date() },
    }), args),
    /need approval/i,
  )
})

test('a judged proceed reaches dispatch only with its server-minted exact fact', async () => {
  const authorization = mintJudgedGmailDraftAuthorization({
    agentId: ids.agent,
    boundary: 'Send routine replies.',
    connectionId: '55555555-5555-4555-8555-555555555555',
    contentFingerprint: args.approvalFingerprint,
    draftActionId: ids.draft,
    grantId: 'grant-judged',
    organizationId: ids.organization,
    requestingUserId: ids.user,
  })
  const result = await authorizeGmailDraftDispatch(context({
    authorization: { judgedGmailDraftAuthorization: authorization },
    grant: {
      boundary: 'Send routine replies.',
      expiresAt: null,
      id: 'grant-judged',
      mode: 'judged',
      revokedAt: null,
    },
  }), {
    connectionId: '55555555-5555-4555-8555-555555555555', id: ids.draft, ownerUserId: ids.user,
  }, args.approvalFingerprint, ids.user)
  assert.deepEqual(result, { consented: false })
})

test('a judged grant without a proceed fact still asks', async () => {
  await assert.rejects(
    authorizeGmailDraftDispatch(context({
      grant: {
        boundary: 'Send routine replies.',
        expiresAt: null,
        id: 'grant-judged',
        mode: 'judged',
        revokedAt: null,
      },
    }), {
      connectionId: '55555555-5555-4555-8555-555555555555', id: ids.draft, ownerUserId: ids.user,
    }, args.approvalFingerprint, ids.user),
    /need approval/i,
  )
})

test('a judged proceed fact loses a revoke race before dispatch', async () => {
  const authorization = mintJudgedGmailDraftAuthorization({
    agentId: ids.agent,
    boundary: 'Send routine replies.',
    connectionId: '55555555-5555-4555-8555-555555555555',
    contentFingerprint: args.approvalFingerprint,
    draftActionId: ids.draft,
    grantId: 'grant-judged',
    organizationId: ids.organization,
    requestingUserId: ids.user,
  })
  await assert.rejects(
    authorizeGmailDraftDispatch(context({
      authorization: { judgedGmailDraftAuthorization: authorization },
      grant: {
        boundary: 'Send routine replies.',
        expiresAt: null,
        id: 'grant-judged',
        mode: 'judged',
        revokedAt: new Date(),
      },
    }), {
      connectionId: '55555555-5555-4555-8555-555555555555', id: ids.draft, ownerUserId: ids.user,
    }, args.approvalFingerprint, ids.user),
    /need approval/i,
  )
})
