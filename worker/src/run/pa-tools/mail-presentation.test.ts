import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { postGmailDraftDoorway } from './gmail-tools.js'
import { runMailPresentTool, runMailboxComposeTool } from './mail-presentation.js'
import {
  appendMailPresentationReferences,
  mailPresentationReference,
} from './mail-presentation-reference.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const IDS = {
  account: '00000000-0000-4000-8000-000000000001',
  agent: '00000000-0000-4000-8000-000000000002',
  channel: '00000000-0000-4000-8000-000000000003',
  organization: '00000000-0000-4000-8000-000000000004',
  project: '00000000-0000-4000-8000-000000000005',
  run: '00000000-0000-4000-8000-000000000006',
  team: '00000000-0000-4000-8000-000000000007',
  thread: '00000000-0000-4000-8000-000000000008',
  user: '00000000-0000-4000-8000-000000000009',
  message: '00000000-0000-4000-8000-000000000010',
}

type CapturedCreate = { data: Record<string, unknown> }

const makeContext = (
  options: { access?: boolean; effectiveUser?: string | null; actorType?: 'agent' | 'user' } = {},
) => {
  const messageCreates: CapturedCreate[] = []
  const draftMessageUpdates: Array<{ where: { id: string }; data: { messageId: string } }> = []
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  const prisma = {
    mailboxConnection: {
      findMany: async () => options.access === false ? [] : [{
        address: 'owner@example.test',
        createdByUserId: IDS.user,
        id: IDS.account,
        label: 'Private mail',
        ownerUserId: IDS.user,
        teamId: null,
      }],
    },
    gmailDraftAction: {
      update: async (input: { where: { id: string }; data: { messageId: string } }) => {
        draftMessageUpdates.push(input)
      },
    },
    message: {
      create: async (input: CapturedCreate) => {
        messageCreates.push(input)
        return {
          content: input.data.content,
          createdAt: new Date('2026-09-04T12:00:00.000Z'),
          id: IDS.message,
          role: input.data.role,
          threadId: input.data.threadId,
        }
      },
    },
    messageBasisScope: { createMany: async () => ({ count: 1 }) },
    organizationMember: {
      findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
    },
    runBasisScope: { createMany: async () => ({ count: 1 }) },
  } as unknown as PrismaClient
  const consumedSources = createConsumedSourceSink()
  const effectiveUser = options.effectiveUser === undefined ? IDS.user : options.effectiveUser
  const context = {
    agentId: IDS.agent,
    agentKind: 'shared',
    actorContext: {
      actionContext: { effectiveUserId: effectiveUser },
      actor: { actorId: IDS.user, actorType: options.actorType ?? 'user' },
      tenant: { organizationId: IDS.organization },
    },
    channel: {
      id: IDS.channel,
      organizationId: IDS.organization,
      teamId: IDS.team,
    },
    consumedSources,
    prisma,
    realtimeTransport: {
      publishWs: async (_scopes: unknown, payload: { event: string; data: Record<string, unknown> }) => {
        events.push(payload)
      },
    },
    run: { id: IDS.run, messageId: IDS.message, threadId: IDS.thread },
    runContext: {
      agent: { id: IDS.agent },
      boundAgentIds: [IDS.agent],
      channel: {
        id: IDS.channel,
        organizationId: IDS.organization,
        projectId: IDS.project,
        teamId: IDS.team,
      },
      consumedSources,
      run: { id: IDS.run, threadId: IDS.thread },
    },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext
  return { context, draftMessageUpdates, events, messageCreates }
}

test('mail_present stamps disclosure and publishes only the restricted message signal', async () => {
  const { context, events, messageCreates } = makeContext()
  const result = await runMailPresentTool(context, {
    accountId: IDS.account,
    mode: 'thread',
    source: 'mailbox',
    threadId: 'provider-thread-7',
  })

  assert.deepEqual(context.consumedSources?.list(), [{ scopeId: IDS.user, scopeType: 'user' }])
  assert.deepEqual(messageCreates[0]?.data.metadata, {
    mailSurfaceDoorway: {
      accountId: IDS.account,
      mode: 'thread',
      source: 'mailbox',
      threadId: 'provider-thread-7',
    },
  })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.event, 'message.new')
  assert.equal(events[0]?.data.restricted, true)
  assert.equal('contentPreview' in (events[0]?.data ?? {}), false)
  assert.match(result.outputPreview, /\/mail\/mailbox\//)
})

test('mail_present refuses a missing access row without revealing why it is unavailable', async () => {
  const { context, events, messageCreates } = makeContext({ access: false })
  await assert.rejects(
    runMailPresentTool(context, { accountId: IDS.account, mode: 'account', source: 'mailbox' }),
    /mail account is not available to you/,
  )
  assert.equal(messageCreates.length, 0)
  assert.equal(events.length, 0)
})

test('mail_present refuses when no effective user can receive the private doorway', async () => {
  const { context, events, messageCreates } = makeContext({
    actorType: 'agent',
    effectiveUser: null,
  })
  await assert.rejects(
    runMailPresentTool(context, { accountId: IDS.account, mode: 'account', source: 'mailbox' }),
    /person who is asking right now/,
  )
  assert.equal(messageCreates.length, 0)
  assert.equal(events.length, 0)
})

test('mailbox_compose returns the universal card template and does not send', async () => {
  const { context, events, messageCreates } = makeContext()
  const result = await runMailboxComposeTool(context, { connectionId: IDS.account })
  const output = JSON.parse(result.outputPreview) as {
    card: { blocks: Array<{ key: string; maxLength?: number }>; actions: Array<{ key: string }> }
    mailPresentation: { reviewUrl: string }
  }
  assert.deepEqual(output.card.blocks.map((block) => block.key), ['to', 'cc', 'bcc', 'subject', 'body'])
  assert.deepEqual(output.card.actions.map((action) => action.key), ['send', 'dismiss'])
  assert.equal(output.card.blocks.find((block) => block.key === 'body')?.maxLength, 100_000)
  assert.equal(output.mailPresentation.reviewUrl, `/mail/mailbox/${IDS.account}/compose`)
  assert.equal(messageCreates.length, 0)
  assert.equal(events.length, 0)
})

test('a Gmail draft doorway stamps its owner basis and never publishes draft copy', async () => {
  const { context, draftMessageUpdates, events, messageCreates } = makeContext()
  const draftId = '00000000-0000-4000-8000-000000000011'

  await postGmailDraftDoorway(context, {
    connectionId: IDS.account,
    contentFingerprint: 'fingerprint',
    id: draftId,
    ownerUserId: IDS.user,
    providerDraftId: 'google-draft',
    revision: 1,
    state: 'draft',
  })

  assert.deepEqual(context.consumedSources?.list(), [{ scopeId: IDS.user, scopeType: 'user' }])
  assert.equal(messageCreates[0]?.data.content, 'Draft ready. Open Mail to review and send it.')
  assert.deepEqual(messageCreates[0]?.data.metadata, {
    mailSurfaceDoorway: {
      accountId: IDS.account,
      draftId,
      mode: 'compose',
      source: 'gmail',
    },
  })
  assert.deepEqual(draftMessageUpdates, [{
    data: { messageId: IDS.message },
    where: { id: draftId },
  }])
  assert.equal(events[0]?.data.restricted, true)
  assert.equal('contentPreview' in (events[0]?.data ?? {}), false)
})

test('mail presentation references carry canonical URLs but no mail copy', () => {
  const gmailRef = mailPresentationReference({
    accountId: IDS.account,
    mode: 'thread',
    source: 'gmail',
    threadId: 'gmail-thread',
  })
  const mailboxRef = mailPresentationReference({
    accountId: IDS.account,
    mode: 'account',
    source: 'mailbox',
  })
  const output = appendMailPresentationReferences('provider result', [gmailRef, mailboxRef])

  assert.deepEqual(JSON.parse(output.split('\n\n')[1] ?? '{}'), {
    mailPresentation: [{
      accountId: IDS.account,
      mode: 'thread',
      reviewUrl: `/mail/gmail/${IDS.account}/threads/gmail-thread`,
      source: 'gmail',
      threadId: 'gmail-thread',
    }, {
      accountId: IDS.account,
      mode: 'account',
      reviewUrl: `/mail/mailbox/${IDS.account}`,
      source: 'mailbox',
    }],
  })
  assert.equal(output.includes('subject'), false)
  assert.equal(output.includes('recipient'), false)
})
