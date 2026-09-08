import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, UoaSessionIdentity } from '@nessie/schemas'

import { isAgentAccessibleToActor } from './agent-access.js'
import { resolveLiveEntitlements, type LiveEntitlements } from './uoa-live-entitlements.js'

export const AGENT_EDIT_AUTHORITY_ERROR_CODES = {
  MEMBERSHIP_INACTIVE: 'AGENT_EDIT_MEMBERSHIP_INACTIVE',
  NOT_ENTITLED: 'AGENT_EDIT_NOT_ENTITLED',
  OWNERSHIP_FORBIDDEN: 'AGENT_OWNERSHIP_CHANGE_FORBIDDEN',
  OWNER_ONLY: 'AGENT_EDIT_OWNER_ONLY',
  PRIVATE_OWNER_ONLY: 'AGENT_EDIT_PRIVATE_OWNER_ONLY',
  SYSTEM_IMMUTABLE: 'SYSTEM_AGENT_IMMUTABLE',
  TODOS_OWNER_REQUIRED: 'AGENT_TODOS_OWNER_REQUIRED',
} as const

export type AgentEditAuthorityErrorCode =
  (typeof AGENT_EDIT_AUTHORITY_ERROR_CODES)[keyof typeof AGENT_EDIT_AUTHORITY_ERROR_CODES]

export class AgentEditAuthorityError extends Error {
  override readonly name = 'AgentEditAuthorityError'
  constructor(public readonly code: AgentEditAuthorityErrorCode, message: string) {
    super(message)
  }
}

export type AgentEditActor = {
  organizationId: string
  uoaIdentity?: UoaSessionIdentity
  userId: string
}

export type EditableAgentRow = {
  id: string
  organizationId: string | null
  ownerUserId: string | null
  systemManaged: boolean
  visibility: string
}

export type AgentOwnershipState = 'private' | 'person_owned' | 'team_owned' | 'system'

export type AgentEditAuthority = {
  canEdit: boolean
  isLiveOwner: boolean
  isOrgOwner: boolean
  ownership: AgentOwnershipState
  refusal?: { code: AgentEditAuthorityErrorCode; message: string }
}

export const agentOwnershipState = (agent: EditableAgentRow): AgentOwnershipState => {
  if (agent.systemManaged) return 'system'
  if (agent.visibility === 'private') return 'private'
  return agent.ownerUserId ? 'person_owned' : 'team_owned'
}

export const resolveAgentEditAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
  verifiedEntitlements?: LiveEntitlements,
): Promise<AgentEditAuthority> => {
  const ownership = agentOwnershipState(agent)
  const deny = (
    code: AgentEditAuthorityErrorCode,
    message: string,
    parts: Pick<AgentEditAuthority, 'isLiveOwner' | 'isOrgOwner'>,
  ): AgentEditAuthority => ({ canEdit: false, ownership, refusal: { code, message }, ...parts })
  if (ownership === 'system') return deny(
    AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
    'This agent is managed by Nessie itself and cannot be edited.',
    { isLiveOwner: false, isOrgOwner: false },
  )
  if (agent.organizationId !== actor.organizationId) return deny(
    AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED,
    'This agent belongs to another team.',
    { isLiveOwner: false, isOrgOwner: false },
  )
  const entitlements = verifiedEntitlements ?? await resolveLiveEntitlements(prisma, {
    organizationId: actor.organizationId,
    uoaIdentity: actor.uoaIdentity,
    userId: actor.userId,
  })
  if (
    entitlements.kind === 'denied'
    || entitlements.organizationId !== actor.organizationId
    || entitlements.userId !== actor.userId
  ) return deny(
    AGENT_EDIT_AUTHORITY_ERROR_CODES.MEMBERSHIP_INACTIVE,
    'Your access to this team is not active, so you cannot edit agents in it.',
    { isLiveOwner: false, isOrgOwner: false },
  )
  const membership = entitlements.kind === 'local'
    ? await prisma.organizationMember.findUnique({
      select: { deactivatedAt: true, role: true },
      where: { organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId } },
    })
    : null
  if (entitlements.kind === 'local' && (!membership || membership.deactivatedAt)) return deny(
    AGENT_EDIT_AUTHORITY_ERROR_CODES.MEMBERSHIP_INACTIVE,
    'Your access to this team is not active, so you cannot edit agents in it.',
    { isLiveOwner: false, isOrgOwner: false },
  )
  const isOrgOwner = entitlements.kind === 'uoa'
    ? entitlements.organizationRole === 'owner'
    : membership?.role === 'owner'
  const isLiveOwner = agent.ownerUserId === actor.userId
  const parts = { isLiveOwner, isOrgOwner }
  if (ownership === 'private') return isLiveOwner
    ? { canEdit: true, ownership, ...parts }
    : deny(AGENT_EDIT_AUTHORITY_ERROR_CODES.PRIVATE_OWNER_ONLY,
      'This is a private agent. Only the person who owns it can edit it.', parts)
  if (ownership === 'person_owned') return isLiveOwner || isOrgOwner
    ? { canEdit: true, ownership, ...parts }
    : deny(AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNER_ONLY,
      'This agent is owned by another person; ask them or an organisation owner to change it.', parts)
  if (isOrgOwner) return { canEdit: true, ownership, ...parts }
  const entitled = await isAgentAccessibleToActor(prisma as PrismaClient, {
    actionContext: { requestId: `agent-edit-authority:${agent.id}`, ...(actor.uoaIdentity ? { uoaIdentity: actor.uoaIdentity } : {}) },
    actor: { actorId: actor.userId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: actor.organizationId },
  } as AuthorizedActionContext, agent.id, entitlements)
  return entitled ? { canEdit: true, ownership, ...parts } : deny(
    AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED,
    'This agent is team-owned, but you cannot reach it from any channel you can see.', parts)
}

export const canEditAgent = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
): Promise<boolean> => (await resolveAgentEditAuthority(prisma, actor, agent)).canEdit

export const assertAgentEditAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
  verifiedEntitlements?: LiveEntitlements,
): Promise<AgentEditAuthority> => {
  const authority = await resolveAgentEditAuthority(prisma, actor, agent, verifiedEntitlements)
  if (!authority.canEdit && authority.refusal) {
    throw new AgentEditAuthorityError(authority.refusal.code, authority.refusal.message)
  }
  return authority
}

export type AgentEditPatch = { ownerUserId?: string | null; todosEnabled?: boolean }

export const assertAgentFieldAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow & { todosEnabled: boolean },
  patch: AgentEditPatch,
  verifiedEntitlements?: LiveEntitlements,
): Promise<AgentEditAuthority> => {
  const authority = await assertAgentEditAuthority(prisma, actor, agent, verifiedEntitlements)
  const changesOwnership = patch.ownerUserId !== undefined
    && (patch.ownerUserId ?? null) !== agent.ownerUserId
  if (changesOwnership && !(authority.isLiveOwner || authority.isOrgOwner)) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNERSHIP_FORBIDDEN,
      patch.ownerUserId === null
        ? 'Only this agent’s owner or an organisation owner can release it to the team.'
        : 'Only this agent’s owner or an organisation owner can change who owns it.',
    )
  }
  const changesTodos = patch.todosEnabled !== undefined && patch.todosEnabled !== agent.todosEnabled
  if (changesTodos && !authority.isOrgOwner) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.TODOS_OWNER_REQUIRED,
      'Only organisation owners can turn an agent’s to-dos on or off.',
    )
  }
  return authority
}
