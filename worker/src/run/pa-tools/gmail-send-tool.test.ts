import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseUserId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { runGmailDraftSendTool } from './gmail-send-tool.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  draft: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  user: '44444444-4444-4444-8444-444444444444',
} as const

const context = (input: {
  approval?: { approvalId?: string; approvalProof?: string }
  grant: { expiresAt: Date | null; revokedAt: Date | null } | null
}): BuiltinToolRuntimeContext => ({
  agentId: ids.agent,
  agentKind: 'personal_assistant',
  actorContext: {
    actionContext: { effectiveUserId: parseUserId(ids.user), requestId: 'gmail-send-tool-test' },
    actor: { actorId: ids.user, actorType: 'user', roles: ['member'] },
    ...(input.approval ? { approval: input.approval } : {}),
    tenant: { organizationId: parseOrganizationId(ids.organization) },
  } as AuthorizedActionContext,
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
            boundary: null,
            expiresAt: input.grant.expiresAt,
            id: 'grant-1',
            mode: 'always',
            revokedAt: input.grant.revokedAt,
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
