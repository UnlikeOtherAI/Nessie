import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, type AuthorizedActionContext } from '@nessie/schemas'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { createToolApprovalRequest } from './tool-approval-requests.js'
import type { RunContext } from './types.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const MAILBOX_ID = '33333333-3333-4333-8333-333333333333'
const ORGANIZATION_ID = '44444444-4444-4444-8444-444444444444'
const PROJECT_ID = '55555555-5555-4555-8555-555555555555'
const RUN_ID = '66666666-6666-4666-8666-666666666666'
const TASK_ID = '77777777-7777-4777-8777-777777777777'
const TEAM_ID = '88888888-8888-4888-8888-888888888888'

const actorContext = (): AuthorizedActionContext => ({
  actor: { actorId: AGENT_ID, actorType: 'agent', roles: [] },
  actionContext: { requestId: 'tool-approval-request-test' },
  tenant: { organizationId: parseOrganizationId(ORGANIZATION_ID) },
})

const runContext = (): RunContext => ({
  agent: { id: AGENT_ID },
  channel: {
    id: CHANNEL_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
  },
  consumedSources: createConsumedSourceSink(),
  run: { id: RUN_ID },
  task: { id: TASK_ID },
}) as unknown as RunContext

test('mailbox-send metadata contains only counts and structural pointers', async () => {
  let created: Record<string, unknown> | null = null
  const prisma = {
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created = data
        return { id: 'approval-1' }
      },
      findFirst: async () => null,
    },
  } as unknown as PrismaClient

  await createToolApprovalRequest(prisma, {
    actorContext: actorContext(),
    args: {
      bcc: ['hidden@example.test'],
      cc: ['copy@example.test'],
      subject: 'A private subject',
      text: 'A private body that appears after the first 200 characters.',
      to: ['recipient@example.test'],
    },
    context: runContext(),
    contextExtra: { externalDisclosureSources: [], mailboxConnectionId: MAILBOX_ID },
    interactive: true,
    messageId: 'message-1',
    requiredApproverUserId: AGENT_ID,
    toolCallId: 'call-1',
    toolName: 'mailbox_send',
  })

  assert.equal(created?.['reason'], 'Approval is required before sending from a connected mailbox.')
  assert.deepEqual(created?.['context'], {
    audience: '3 recipients will receive it',
    externalDisclosureSources: [],
    headline: 'Send an email from a connected mailbox',
    mailboxConnectionId: MAILBOX_ID,
  })
  assert.doesNotMatch(
    JSON.stringify({ context: created?.['context'], reason: created?.['reason'] }),
    /private subject|private body|hidden@example|inputSummary|boundaryReason/,
  )
})
