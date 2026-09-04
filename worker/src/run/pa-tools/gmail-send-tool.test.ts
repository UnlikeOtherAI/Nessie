import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOrganizationId } from '@nessie/schemas'

import { runGmailDraftSendTool } from './gmail-send-tool.js'

const ORGANIZATION = '11111111-1111-4111-8111-111111111111'
const CONNECTION = '22222222-2222-4222-8222-222222222222'
const DRAFT = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'

test('a raw resumed payload proof cannot authorize a Gmail send handler', async () => {
  const context = {
    agentId: 'agent-1',
    actorContext: {
      actor: { actorId: USER, actorType: 'user', roles: [] },
      approval: { approvalId: 'approval-1', approvalProof: 'untrusted-raw-token' },
      actionContext: { effectiveUserId: USER, purpose: 'chat', requestId: 'test' },
      tenant: { organizationId: parseOrganizationId(ORGANIZATION) },
    },
    channel: { id: 'channel-1', organizationId: parseOrganizationId(ORGANIZATION) },
    prisma: {
      commsConnection: { findFirst: async () => null },
      gmailDraftAction: {
        findFirst: async () => ({
          connectionId: CONNECTION,
          id: DRAFT,
          ownerUserId: USER,
          state: 'draft',
        }),
      },
    },
    run: { id: 'run-1', interactive: true, messageId: 'message-1', threadId: 'thread-1' },
  }

  await assert.rejects(
    runGmailDraftSendTool(context as never, { draftId: DRAFT }),
    /need approval before sending/i,
  )
})

test('a trusted standing decision reaches Gmail send without a second grant check', async () => {
  const context = {
    agentId: 'agent-1',
    actorContext: {
      actor: { actorId: USER, actorType: 'user', roles: [] },
      actionContext: { effectiveUserId: USER, purpose: 'chat', requestId: 'test' },
      tenant: { organizationId: parseOrganizationId(ORGANIZATION) },
    },
    channel: { id: 'channel-1', organizationId: parseOrganizationId(ORGANIZATION) },
    gmailDraftSendStandingAuthorized: true as const,
    prisma: {
      gmailDraftAction: {
        // A state error from the durable sender proves this handler crossed the
        // standing gate without calling the old always-only grant lookup.
        findFirst: async () => ({
          connectionId: CONNECTION,
          contentFingerprint: 'fingerprint',
          id: DRAFT,
          ownerUserId: USER,
          providerDraftId: 'provider-draft',
          state: 'sending',
        }),
      },
    },
    run: { id: 'run-1', interactive: true, messageId: 'message-1', threadId: 'thread-1' },
  }

  await assert.rejects(
    runGmailDraftSendTool(context as never, { draftId: DRAFT }),
    /already been sent or is being sent/i,
  )
})
