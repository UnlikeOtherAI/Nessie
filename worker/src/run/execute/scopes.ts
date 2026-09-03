import { parseAgentId, parseChannelId, parseOrganizationId, type WsScope } from '@nessie/schemas'

import { runDelegatesToRequestingPerson } from '../delegated-identity.js'
import type { RunContext } from './types.js'

/**
 * Realtime scopes a run publishes on.
 *
 * A delegate's own single-member home DM — the Personal Assistant's, or a
 * DM-homed global agent's — publishes on the channel lane ALONE. The
 * organisation and agent lanes are team-wide broadcast: an organisation
 * lane would put one person's private conversation in front of everybody, and
 * the agent lane would do the same across every member's home DM, since a
 * global agent is one org-wide row shared by all of them. The api side already
 * narrows these surfaces (`isDelegatedSystemDmChannelType` in
 * `request-helpers.ts`); this is the worker's half of the same rule, now
 * expressed through the one delegation predicate so the two cannot disagree.
 */
export const buildScopesForAgent = (
  channel: RunContext['channel'],
  agent: { agentKind: RunContext['agent']['agentKind']; id: string; systemSlug?: string | null },
): WsScope[] => [
  {
    kind: 'channel',
    channelId: parseChannelId(channel.id),
  },
  ...(runDelegatesToRequestingPerson({
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
