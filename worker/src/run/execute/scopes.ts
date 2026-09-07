import { parseAgentId, parseChannelId, parseOrganizationId, type WsScope } from '@nessie/schemas'

import { runDelegatesToRequestingPerson } from '../delegated-identity.js'
import type { RunContext } from './types.js'

/**
 * Realtime scopes a run publishes on.
 *
 * Non-public rooms publish on their channel lane ALONE. Organisation and agent
 * lanes are broad broadcasts, so either would expose private run progress,
 * tool inputs, and completion previews to people outside the room. Delegated
 * system DMs have the same containment even if their visibility is malformed.
 */
export const buildScopesForAgent = (
  channel: RunContext['channel'],
  agent: { agentKind: RunContext['agent']['agentKind']; id: string; systemSlug?: string | null },
): WsScope[] => [
  {
    kind: 'channel',
    channelId: parseChannelId(channel.id),
  },
  ...(channel.visibility !== 'public' || runDelegatesToRequestingPerson({
    agentKind: agent.agentKind,
    dmKey: channel.dmKey,
    organizationId: channel.organizationId,
    systemChannelType: channel.systemChannelType,
    systemSlug: agent.systemSlug,
  })
    ? []
    : [
        {
          kind: 'organization' as const,
          organizationId: parseOrganizationId(channel.organizationId),
        },
        {
          kind: 'agent' as const,
          agentId: parseAgentId(agent.id),
        },
      ]),
]

export const buildScopes = (context: RunContext): WsScope[] => [
  ...buildScopesForAgent(context.channel, {
    agentKind: context.agent.agentKind,
    id: context.agent.id,
    systemSlug: context.agent.systemSlug,
  }),
]
