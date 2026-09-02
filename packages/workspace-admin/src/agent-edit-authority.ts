import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { isAgentAccessibleToActor } from './access-checks.js'

/**
 * Who may rewrite an agent.
 *
 * Every agent-mutation route used to gate on the ORGANIZATION owner role, so no
 * ordinary member could edit any agent — not even the private one they own. The
 * replacement derives edit authority from the stewardship fact that already
 * exists, as a fourth *state* rather than a fourth tab:
 *
 * - **Private** (`visibility='private'`) — the live owner alone. An
 *   organization owner cannot see it, so cannot edit it.
 * - **Workspace, person-owned** (`ownerUserId` set) — the live owner, plus
 *   organization owners as a governance/recovery override.
 * - **Workspace, team-owned** (`ownerUserId` null) — anyone entitled to the
 *   agent, plus organization owners.
 * - **Global** (`systemManaged`) — nobody; the blueprint only.
 *
 * "Team-owned means any member who can see the agent may rewrite its prompt,
 * model, tools and limits" is the deliberate widening: editing improves a shared
 * agent in place, while *placement* (`agent_bind_channel`) keeps its stricter
 * four gates.
 *
 * Owner-ness is re-derived from the live `OrganizationMember` row on every call,
 * never from the session claim or a run's enqueue-time snapshot — a deactivated
 * member edits nothing, and a demoted org owner loses the override immediately.
 *
 * Editing is field-sensitive: `UpdateAgentBodySchema` also carries
 * `ownerUserId` and `todosEnabled`, and one predicate over the whole body would
 * let any entitled member claim a team-owned agent or switch on owner-gated
 * to-dos. `assertAgentFieldAuthority` is the second half of the contract.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md → "Edit authority".
 */

export const AGENT_EDIT_AUTHORITY_ERROR_CODES = {
  /** The acting membership is absent or deactivated. */
  MEMBERSHIP_INACTIVE: 'AGENT_EDIT_MEMBERSHIP_INACTIVE',
  /** A team-owned agent the actor is not entitled to see. */
  NOT_ENTITLED: 'AGENT_EDIT_NOT_ENTITLED',
  /** Transfer, release, or claim attempted by someone who is neither. */
  OWNERSHIP_FORBIDDEN: 'AGENT_OWNERSHIP_CHANGE_FORBIDDEN',
  /** A person-owned workspace agent, edited by neither its owner nor an org owner. */
  OWNER_ONLY: 'AGENT_EDIT_OWNER_ONLY',
  /** A private agent, edited by anyone but its live owner. */
  PRIVATE_OWNER_ONLY: 'AGENT_EDIT_PRIVATE_OWNER_ONLY',
  /** A blueprint-managed agent. Nobody edits one, org owners included. */
  SYSTEM_IMMUTABLE: 'SYSTEM_AGENT_IMMUTABLE',
  /** `todosEnabled` keeps its own, narrower org-owner gate. */
  TODOS_OWNER_REQUIRED: 'AGENT_TODOS_OWNER_REQUIRED',
} as const

export type AgentEditAuthorityErrorCode =
  (typeof AGENT_EDIT_AUTHORITY_ERROR_CODES)[keyof typeof AGENT_EDIT_AUTHORITY_ERROR_CODES]

export class AgentEditAuthorityError extends Error {
  override readonly name = 'AgentEditAuthorityError'

  constructor(
    public readonly code: AgentEditAuthorityErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** The person doing the editing, resolved against one organization. */
export type AgentEditActor = {
  organizationId: string
  userId: string
}

/**
 * The columns the predicate reads. Deliberately the row, not an id: every
 * caller has already loaded the agent (to 404 an invisible one), and a second
 * read could see a different row than the one being written.
 */
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
  /** The actor is the agent's steward AND still an active member. */
  isLiveOwner: boolean
  /** The actor holds the `owner` role on the live membership row. */
  isOrgOwner: boolean
  ownership: AgentOwnershipState
  /** Set whenever `canEdit` is false. */
  refusal?: { code: AgentEditAuthorityErrorCode; message: string }
}

export const agentOwnershipState = (agent: EditableAgentRow): AgentOwnershipState => {
  if (agent.systemManaged) return 'system'
  if (agent.visibility === 'private') return 'private'
  return agent.ownerUserId ? 'person_owned' : 'team_owned'
}

const ownerDisplayName = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  ownerUserId: string | null,
): Promise<string> => {
  if (!ownerUserId) return 'another member'
  const owner = await prisma.user.findUnique({
    select: { displayName: true },
    where: { id: ownerUserId },
  })
  return owner?.displayName?.trim() || 'another member'
}

/**
 * The whole-agent gate. One live membership read, plus the entitlement read only
 * where team-ownership actually needs it.
 */
export const resolveAgentEditAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
): Promise<AgentEditAuthority> => {
  const ownership = agentOwnershipState(agent)
  const deny = (
    code: AgentEditAuthorityErrorCode,
    message: string,
    parts: Pick<AgentEditAuthority, 'isLiveOwner' | 'isOrgOwner'>,
  ): AgentEditAuthority => ({
    canEdit: false,
    ownership,
    refusal: { code, message },
    ...parts,
  })

  if (ownership === 'system') {
    return deny(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.SYSTEM_IMMUTABLE,
      'This agent is managed by Nessie itself and cannot be edited.',
      { isLiveOwner: false, isOrgOwner: false },
    )
  }

  // Tenancy first: an agent from another organization is never this actor's to
  // edit, whatever their role here.
  if (agent.organizationId !== actor.organizationId) {
    return deny(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED,
      'This agent belongs to another workspace.',
      { isLiveOwner: false, isOrgOwner: false },
    )
  }

  const membership = await prisma.organizationMember.findUnique({
    select: { deactivatedAt: true, role: true },
    where: {
      organizationId_userId: {
        organizationId: actor.organizationId,
        userId: actor.userId,
      },
    },
  })
  if (!membership || membership.deactivatedAt) {
    return deny(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.MEMBERSHIP_INACTIVE,
      'Your access to this workspace is not active, so you cannot edit agents in it.',
      { isLiveOwner: false, isOrgOwner: false },
    )
  }

  const isOrgOwner = membership.role === 'owner'
  const isLiveOwner = agent.ownerUserId === actor.userId
  const parts = { isLiveOwner, isOrgOwner }

  if (ownership === 'private') {
    // Private beats owner omniscience: an org owner cannot see this agent, so
    // there is nothing for them to edit.
    return isLiveOwner
      ? { canEdit: true, ownership, ...parts }
      : deny(
          AGENT_EDIT_AUTHORITY_ERROR_CODES.PRIVATE_OWNER_ONLY,
          'This is a private agent. Only the person who owns it can edit it.',
          parts,
        )
  }

  if (ownership === 'person_owned') {
    if (isLiveOwner || isOrgOwner) return { canEdit: true, ownership, ...parts }
    return deny(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNER_ONLY,
      `This agent is owned by ${await ownerDisplayName(prisma, agent.ownerUserId)}; `
        + 'ask them or an organisation owner to change it.',
      parts,
    )
  }

  // Team-owned: anyone entitled to the agent, which an org owner always is.
  if (isOrgOwner) return { canEdit: true, ownership, ...parts }
  const entitled = await isAgentAccessibleToActor(
    prisma as PrismaClient,
    {
      actionContext: { requestId: `agent-edit-authority:${agent.id}` },
      actor: { actorId: actor.userId, actorType: 'user', roles: [membership.role] },
      tenant: { organizationId: actor.organizationId },
    } as AuthorizedActionContext,
    agent.id,
  )
  return entitled
    ? { canEdit: true, ownership, ...parts }
    : deny(
        AGENT_EDIT_AUTHORITY_ERROR_CODES.NOT_ENTITLED,
        'This agent is team-owned, but you cannot reach it from any channel you can see.',
        parts,
      )
}

/** The predicate on its own, for surfaces that only need a yes or no. */
export const canEditAgent = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
): Promise<boolean> => (await resolveAgentEditAuthority(prisma, actor, agent)).canEdit

/** The same question, refusing in words. Returns the authority for reuse. */
export const assertAgentEditAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow,
): Promise<AgentEditAuthority> => {
  const authority = await resolveAgentEditAuthority(prisma, actor, agent)
  if (!authority.canEdit && authority.refusal) {
    throw new AgentEditAuthorityError(authority.refusal.code, authority.refusal.message)
  }
  return authority
}

/**
 * The patch shape the field gates read. Only the two fields that carry their own
 * authority are named; everything else is an ordinary edit field.
 */
export type AgentEditPatch = {
  /** `undefined` leaves stewardship alone; `null` releases the agent to the team. */
  ownerUserId?: string | null
  todosEnabled?: boolean
}

/**
 * Edit authority plus the two narrower gates over the same body.
 *
 * - ownership transitions (transfer, release-to-team, claim) — the current owner
 *   or an org owner, never mere edit entitlement. Claiming a team-owned agent is
 *   therefore org-owner-only by construction: a team-owned agent has no current
 *   owner to be.
 * - `todosEnabled` — org owners only, unchanged: it authorizes trigger-driven
 *   work, a different blast radius from rewording a prompt.
 *
 * Both gates fire only on an actual CHANGE. A form that echoes the stored value
 * back is not an attempt to transfer or to toggle, and refusing it would make an
 * ordinary edit impossible for everybody but an org owner — the bug this
 * replaces.
 */
export const assertAgentFieldAuthority = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: AgentEditActor,
  agent: EditableAgentRow & { todosEnabled: boolean },
  patch: AgentEditPatch,
): Promise<AgentEditAuthority> => {
  const authority = await assertAgentEditAuthority(prisma, actor, agent)

  const changesOwnership =
    patch.ownerUserId !== undefined
    && (patch.ownerUserId ?? null) !== agent.ownerUserId
  if (changesOwnership && !(authority.isLiveOwner || authority.isOrgOwner)) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.OWNERSHIP_FORBIDDEN,
      patch.ownerUserId === null
        ? 'Only this agent’s owner or an organisation owner can release it to the team.'
        : 'Only this agent’s owner or an organisation owner can change who owns it.',
    )
  }

  const changesTodos =
    patch.todosEnabled !== undefined && patch.todosEnabled !== agent.todosEnabled
  if (changesTodos && !authority.isOrgOwner) {
    throw new AgentEditAuthorityError(
      AGENT_EDIT_AUTHORITY_ERROR_CODES.TODOS_OWNER_REQUIRED,
      'Only organisation owners can turn an agent’s to-dos on or off.',
    )
  }

  return authority
}
