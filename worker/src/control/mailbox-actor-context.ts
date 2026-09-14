import { randomUUID } from 'node:crypto'

import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  UoaSessionIdentitySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

export const buildMailboxActorContext = (input: {
  actorId: string
  actorType: 'agent' | 'service' | 'user'
  channelId: string
  organizationId: string
  projectId: string | null
  targetAgentId: string
  teamId: string | null
  peerDelegationDepth?: number | null
  uoaIdentity?: unknown
  taskId?: string
  threadId: string
}): AuthorizedActionContext => {
  const isPeerDelegation =
    input.peerDelegationDepth !== null && input.peerDelegationDepth !== undefined
  // This immutable tuple is run provenance, never an identity or credential
  // store. Ledger revalidates it against the original human's live UOA link.
  const uoaIdentity = isPeerDelegation && input.uoaIdentity !== undefined && input.uoaIdentity !== null
    ? UoaSessionIdentitySchema.parse(input.uoaIdentity)
    : undefined
  if (isPeerDelegation && input.actorType !== 'user') {
    throw new Error('Peer delegation requires its original human requester.')
  }
  return {
    actor: {
      actorId: input.actorId,
      actorType: input.actorType,
      ...(input.actorType === 'agent' ? { roles: ['system'] } : {}),
    },
    actionContext: {
      agentId: parseAgentId(input.targetAgentId),
      channelId: parseChannelId(input.channelId),
      correlationId: undefined,
      purpose: 'mailbox.delivery',
      requestId: randomUUID(),
      ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
      ...(isPeerDelegation
        ? {
            effectiveUserId: parseUserId(input.actorId),
            purpose: 'agent.peer_delegation',
            correlationId: String(input.peerDelegationDepth),
            ...(uoaIdentity ? { uoaIdentity } : {}),
          }
        : {}),
      threadId: parseThreadId(input.threadId),
    },
    tenant: {
      organizationId: parseOrganizationId(input.organizationId),
      ...(input.projectId ? { projectId: parseProjectId(input.projectId) } : {}),
      ...(input.teamId ? { teamId: parseTeamId(input.teamId) } : {}),
    },
  }
}