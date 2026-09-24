import type { Prisma } from '@prisma/client'
import {
  isAdminRole,
  TicketChangedWorkConfigSchema,
  type StandingPolicyMachineRefusal,
  type TicketChangedWorkConfig,
} from '@nessie/schemas'

import { canMemberEditProjectBoards } from './resource-authority.js'
import { agentTriggerScopeWhere } from './trigger-lifecycle.js'

/**
 * The trigger a standing policy is for, checked as its author must find it
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "Prepare
 * and confirm"): a live, enabled ticket trigger that starts work and says
 * what to do, which the person asking set up, on a board they can still edit.
 *
 * Only its author may prepare: a preparer who is not would learn which private
 * machines the author has, and every command the work runs would run as the
 * author. `config.authorUserId` is authorship and grants nothing else
 * (docs/standards/ticket-work.md → "Authorship grants nothing").
 */

/** A refusal said to the person asking, with each machine's reason when machines were the problem. */
export class StandingPolicyRefusal extends Error {
  readonly code = 'MACHINE_ACCESS_REFUSED'

  constructor(
    message: string,
    readonly machines: ReadonlyArray<{
      executorId: string
      label: string | null
      reason: StandingPolicyMachineRefusal
      sentence: string
    }> = [],
  ) {
    super(message)
    this.name = 'StandingPolicyRefusal'
  }
}

export type StandingPolicyTrigger = {
  agentId: string
  agentName: string
  authorName: string
  config: TicketChangedWorkConfig & { instructions: NonNullable<TicketChangedWorkConfig['instructions']> }
  id: string
  name: string
  projectId: string
  row: { agentId: string; config: unknown; id: string; targetChannelId: string }
  targetChannelId: string
}

export const loadStandingPolicyTrigger = async (
  tx: Prisma.TransactionClient,
  input: {
    authorUserId: string
    /** The request's own verified role, when a REST door has one. */
    isOrganizationAdmin?: boolean
    organizationId: string
    triggerId: string
  },
): Promise<StandingPolicyTrigger> => {
  const trigger = await tx.agentTrigger.findFirst({
    where: agentTriggerScopeWhere({ organizationId: input.organizationId, triggerId: input.triggerId }),
    select: {
      agent: { select: { name: true } }, agentId: true, config: true, enabled: true, id: true, name: true,
      scopeProjectId: true, status: true, targetChannelId: true, type: true,
    },
  })
  if (!trigger?.agentId || !trigger.agent) throw new StandingPolicyRefusal('Trigger not found.')
  const stored = trigger.config && typeof trigger.config === 'object'
    ? (trigger.config as { authorUserId?: unknown }).authorUserId
    : undefined
  if (typeof stored !== 'string') {
    throw new StandingPolicyRefusal('This trigger records nobody who set it up, so nobody can set up machine access '
      + 'for it. Create it again.')
  }
  const author = await tx.user.findUnique({ where: { id: stored }, select: { displayName: true } })
  const authorName = author?.displayName ?? 'the person who set it up'
  if (stored !== input.authorUserId) {
    throw new StandingPolicyRefusal(`Only ${authorName}, who set this trigger up, can set up machine access for it: `
      + `the work would run on their own machines, as them. Ask ${authorName} to set it up from the trigger's `
      + 'Machine access section or with the Agent Designer.')
  }
  if (trigger.type !== 'ticket_changed') {
    throw new StandingPolicyRefusal('Machine access is for ticket triggers only.')
  }
  if (!trigger.enabled || trigger.status !== 'active') {
    throw new StandingPolicyRefusal('Switch the trigger on first. A switched-off trigger holds no machine access.')
  }
  const config = TicketChangedWorkConfigSchema.safeParse(trigger.config)
  if (!config.success || !trigger.scopeProjectId || !trigger.targetChannelId) {
    throw new StandingPolicyRefusal('This trigger\'s configuration no longer holds together. Open it and save it again.')
  }
  if (!config.data.pickup) {
    throw new StandingPolicyRefusal('This trigger never starts work (it has no start-work columns), so there is '
      + 'nothing for a machine to do.')
  }
  const instructions = config.data.instructions
  if (!instructions) {
    throw new StandingPolicyRefusal('Write the trigger\'s instructions first. The confirmation shows them to you word '
      + 'for word.')
  }
  const canEdit = await canMemberEditProjectBoards(tx, {
    organizationId: input.organizationId,
    projectId: trigger.scopeProjectId,
    userId: input.authorUserId,
    ...(input.isOrganizationAdmin === undefined ? {} : { isOrganizationAdmin: input.isOrganizationAdmin }),
  })
  if (!canEdit) {
    throw new StandingPolicyRefusal('You can no longer edit this trigger\'s board, so you cannot give its work your '
      + 'machines.')
  }
  return {
    agentId: trigger.agentId,
    agentName: trigger.agent.name,
    authorName,
    config: { ...config.data, instructions },
    id: trigger.id,
    name: trigger.name ?? `${trigger.agent.name}'s ticket trigger`,
    projectId: trigger.scopeProjectId,
    row: { agentId: trigger.agentId, config: trigger.config, id: trigger.id, targetChannelId: trigger.targetChannelId },
    targetChannelId: trigger.targetChannelId,
  }
}

/**
 * How many people can start work on this board right now: every live
 * organisation owner or admin, and every live member of the project — the
 * people `canMemberEditProjectBoards` says yes to, which is who the card warns
 * the author about.
 */
export const countStandingPolicyBoardEditors = async (
  tx: Prisma.TransactionClient,
  input: { organizationId: string; projectId: string },
): Promise<number> => {
  const [members, projectMembers] = await Promise.all([
    tx.organizationMember.findMany({
      where: { deactivatedAt: null, organizationId: input.organizationId },
      select: { role: true, userId: true },
    }),
    tx.projectMember.findMany({ where: { projectId: input.projectId }, select: { userId: true } }),
  ])
  const inProject = new Set(projectMembers.map((member) => member.userId))
  return members.filter((member) => isAdminRole(member.role) || inProject.has(member.userId)).length
}
