import { randomUUID } from 'node:crypto'

import {
  MAILBOX_DELIVERY_PURPOSE,
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseTeamId,
  parseThreadId,
  parseUserId,
  TASK_SET_DELIVERY_PURPOSE,
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
  taskSetId?: string | null
  uoaIdentity?: unknown
  taskId?: string
  threadId: string
}): AuthorizedActionContext => {
  const isPeerDelegation =
    input.peerDelegationDepth !== null && input.peerDelegationDepth !== undefined
  const isTaskSetDelivery = input.taskSetId !== null && input.taskSetId !== undefined
  const carriesRequester = isPeerDelegation || isTaskSetDelivery
  // This immutable tuple is run provenance, never an identity or credential
  // store. Ledger revalidates it against the original human's live UOA link.
  const uoaIdentity = carriesRequester && input.uoaIdentity !== undefined && input.uoaIdentity !== null
    ? UoaSessionIdentitySchema.parse(input.uoaIdentity)
    : undefined
  if (carriesRequester && input.actorType !== 'user') {
    throw new Error('Provenance-carrying delivery requires its original human requester.')
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
      purpose: MAILBOX_DELIVERY_PURPOSE,
      requestId: randomUUID(),
      ...(input.taskId ? { taskId: parseTaskId(input.taskId) } : {}),
      ...(carriesRequester
        ? {
            effectiveUserId: parseUserId(input.actorId),
            purpose: isTaskSetDelivery ? TASK_SET_DELIVERY_PURPOSE : 'agent.peer_delegation',
            correlationId: isTaskSetDelivery ? `task-set:${input.taskSetId}` : String(input.peerDelegationDepth),
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
