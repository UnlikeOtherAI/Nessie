import { randomUUID } from 'node:crypto'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseTaskId,
  parseThreadId,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'

/**
 * The actor an inbound email run acts as.
 *
 * Deliberately a **service** actor with no user id. The sender is a stranger
 * outside the team: their address must never become local authority, and
 * minting a synthetic user for them would put an unaccountable principal in the
 * audit trail and the ledger. Everything the run may do it may do because the
 * *agent* is entitled to it, never because the email asked.
 */
export const buildInboundEmailActorContext = (input: {
  agentId: string
  channelId: string
  organizationId: string
  threadId: string
  taskId?: string
}): AuthorizedActionContext => ({
  actionContext: {
    agentId: parseAgentId(input.agentId),
    channelId: parseChannelId(input.channelId),
    correlationId: undefined,
    purpose: 'agent-email.inbound',
    requestId: randomUUID(),
    ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
    threadId: parseThreadId(input.threadId),
  },
  actor: {
    actorId: input.agentId,
    actorType: 'service',
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
  },
})

export const buildEmailScopes = (input: {
  agentId: string
  channelId: string
  organizationId: string
}): WsScope[] => [
  { kind: 'organization', organizationId: parseOrganizationId(input.organizationId) },
  { channelId: parseChannelId(input.channelId), kind: 'channel' },
  { agentId: parseAgentId(input.agentId), kind: 'agent' },
]
