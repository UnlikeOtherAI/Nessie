import assert from 'node:assert/strict'
import test from 'node:test'
import type { BuiltinToolRuntimeContext } from './tool-types.js'
import { runChannelFindTool } from './pa-tools/channels.js'

const makeContext = (channels: unknown[]): BuiltinToolRuntimeContext =>
  ({
    actorContext: {
      actionContext: {},
      actor: { actorId: 'user-1', actorType: 'user' },
      tenant: {
        organizationId: 'org-1',
        projectId: 'project-1',
        teamId: 'team-1',
      },
    },
    agentId: 'agent-1',
    agentKind: 'personal_assistant',
    channel: { id: 'channel-current', organizationId: 'org-1' },
    prisma: {
      channel: {
        findMany: async () => channels,
      },
    },
    realtimeTransport: {},
    run: {
      id: 'run-1',
      messageId: 'message-1',
      threadId: 'thread-1',
    },
  }) as unknown as BuiltinToolRuntimeContext

const duplicateGeneralChannels = [
  {
    id: 'channel-default',
    label: 'General',
    slug: 'general',
    visibility: 'public',
    team: {
      name: 'Default Team',
      project: { name: 'Default Project' },
    },
  },
  {
    id: 'channel-qa',
    label: 'General',
    slug: 'general',
    visibility: 'public',
    team: {
      name: 'Mention QA Team',
      project: { name: 'Mention QA Project' },
    },
  },
]

test('channel_find returns scoped slugs for duplicate channel names', async () => {
  const result = await runChannelFindTool(
    makeContext(duplicateGeneralChannels),
    { query: 'general' },
  )

  assert.match(result.outputPreview, /#General \(Default Project \/ Default Team\)/)
  assert.match(result.outputPreview, /slug=default-project\/general/)
  assert.match(result.outputPreview, /#General \(Mention QA Project \/ Mention QA Team\)/)
  assert.match(result.outputPreview, /slug=mention-qa-project\/general/)
})

test('channel_find filters scoped channel slug queries to the requested project', async () => {
  const result = await runChannelFindTool(
    makeContext(duplicateGeneralChannels),
    { query: 'mention-qa-project/general' },
  )

  assert.doesNotMatch(result.outputPreview, /channel-default/)
  assert.match(result.outputPreview, /channel-qa/)
  assert.match(result.outputPreview, /slug=mention-qa-project\/general/)
})
