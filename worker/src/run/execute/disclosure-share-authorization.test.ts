import assert from 'node:assert/strict'
import test from 'node:test'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { maybeAuthorizeDisclosureShare } from './disclosure-share-authorization.js'
import type { RunContext } from './types.js'

const AUTHOR = '11111111-1111-4111-8111-111111111111'
const CHANNEL = '22222222-2222-4222-8222-222222222222'
const THREAD = '33333333-3333-4333-8333-333333333333'

const context = (): RunContext => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.addPrivateConversationSource({
    sourceAuthorUserId: AUTHOR,
    sourceChannelId: CHANNEL,
  })
  return {
    channel: { organizationId: 'org-1' },
    consumedSources,
    run: { threadId: THREAD },
  } as RunContext
}

test('a delegated user-message cannot mint automatic private-conversation consent', async () => {
  let utilityCalled = false
  const allowed = await maybeAuthorizeDisclosureShare({
    actorContext: {
      actionContext: { effectiveUserId: AUTHOR },
      actor: { actorId: AUTHOR, actorType: 'user', roles: [] },
    } as never,
    args: { content: 'private details', channelId: CHANNEL },
    context: context(),
    prisma: {
      message: {
        findFirst: async () => ({
          agentId: null,
          content: 'Can you share this with the group?',
          metadata: { delegatedByAgentId: 'agent-1', delegatedFromRunId: 'run-1' },
          onBehalfOfUserId: null,
          role: 'user',
          userId: AUTHOR,
        }),
      },
    } as never,
    runUtility: async () => {
      utilityCalled = true
      return '{"share":true}'
    },
    toolName: 'send_message',
    triggerMessageId: '44444444-4444-4444-8444-444444444444',
  })

  assert.equal(allowed, false)
  assert.equal(utilityCalled, false)
})
