import { parseAgentId, parseChannelId, parseOrganizationId, type WsScope } from '@nessie/schemas'
import type { RunContext } from './types.js'

export const buildScopesForAgent = (
  channel: RunContext['channel'],
  agentId: string,
): WsScope[] => [
  {
    kind: 'channel',
    channelId: parseChannelId(channel.id),
  },
  ...(channel.systemChannelType === 'personal_assistant'
    ? []
    : [
        {
          kind: 'organization' as const,
          organizationId: parseOrganizationId(channel.organizationId),
        },
        {
          kind: 'agent' as const,
          agentId: parseAgentId(agentId),
        },
      ]),
]

export const buildScopes = (context: RunContext): WsScope[] => [
  ...buildScopesForAgent(context.channel, context.agent.id),
]
