import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runSendMessageTool } from './message-delivery.js'

const AGENT_ID = '00000000-0000-4000-8000-000000000001'
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '00000000-0000-4000-8000-000000000003'
const MESSAGE_ID = '00000000-0000-4000-8000-000000000004'
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000005'
const PROJECT_ID = '00000000-0000-4000-8000-000000000006'
const RUN_ID = '00000000-0000-4000-8000-000000000007'
const TEAM_ID = '00000000-0000-4000-8000-000000000008'
const THREAD_ID = '00000000-0000-4000-8000-000000000009'
const USER_ID = '00000000-0000-4000-8000-000000000010'

type AttachmentUpdate = {
  data: { messageId: string }
  where: {
    id: { in: string[] }
    messageId: null
    organizationId: string
    uploaderId: string
  }
}

const makeHarness = (linkedCount: number) => {
  const attachmentUpdates: AttachmentUpdate[] = []
  const published: unknown[] = []
  const channel = {
    id: CHANNEL_ID,
    label: 'Design',
    systemChannelType: null,
    team: { name: 'Studio', project: { name: 'Nessie' } },
    type: 'standard' as const,
  }
  const tx = {
    attachment: {
      updateMany: async (input: AttachmentUpdate) => {
        attachmentUpdates.push(input)
        return { count: linkedCount }
      },
    },
    message: {
      create: async () => ({ id: MESSAGE_ID, createdAt: new Date(), threadId: THREAD_ID }),
    },
  }
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    channel: {
      findUnique: async () => ({ agentBindings: [], organizationId: ORGANIZATION_ID }),
    },
    thread: {
      findFirst: async () => ({ id: THREAD_ID, title: 'General', channel }),
    },
  }
  const context = {
    agentId: AGENT_ID,
    agentKind: 'personal_assistant' as const,
    actorContext: {
      actionContext: {
        agentId: AGENT_ID,
        channelId: CHANNEL_ID,
        correlationId: 'request-correlation',
        effectiveUserId: USER_ID,
        requestId: 'request-id',
        teamId: TEAM_ID,
        threadId: THREAD_ID,
      },
      actor: { actorId: USER_ID, actorType: 'user' as const, roles: ['owner'] },
      tenant: {
        channelId: CHANNEL_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        teamId: TEAM_ID,
      },
    },
    channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID, systemChannelType: null },
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {
      publishWs: async (_scopes: unknown, event: unknown) => {
        published.push(event)
      },
    },
    run: { id: RUN_ID, messageId: MESSAGE_ID, threadId: THREAD_ID },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext

  return { attachmentUpdates, context, published }
}

test('send_message links the acting user\'s pending image upload to its new message', async () => {
  const { attachmentUpdates, context, published } = makeHarness(1)

  const result = await runSendMessageTool(context, {
    attachmentIds: [ATTACHMENT_ID],
    content: 'Here is the chart I evaluated.',
  })

  assert.deepEqual(attachmentUpdates, [{
    data: { messageId: MESSAGE_ID },
    where: {
      id: { in: [ATTACHMENT_ID] },
      messageId: null,
      organizationId: ORGANIZATION_ID,
      uploaderId: USER_ID,
    },
  }])
  assert.match(result.outputPreview, /attachmentsLinked=1/)
  assert.equal(published.length, 1, 'the attachment-bearing message is announced')
})

test('send_message refuses a foreign or already-linked attachment instead of claiming it sent', async () => {
  const { attachmentUpdates, context, published } = makeHarness(0)

  await assert.rejects(
    () => runSendMessageTool(context, {
      attachmentIds: [ATTACHMENT_ID],
      content: 'Here is the chart I evaluated.',
    }),
    /Each attachment must be one of your own still-unlinked uploads/,
  )

  assert.equal(attachmentUpdates.length, 1)
  assert.equal(published.length, 0, 'a rejected attachment claim is not announced')
})
