import type { ProjectTaskRecord } from '@nessie/team-admin'
import { getProjectTask, isAgentAccessibleToActor, isProjectAccessibleToUser } from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import type { ActingMember } from './access.js'

/**
 * What every ticket tool needs before and after it touches a ticket: the
 * shared argument vocabulary, the project gate, the disclosure basis, and the
 * one line a ticket is rendered as.
 *
 * These are shared because they are decisions, not conveniences — a second
 * spelling of the project gate or of the disclosure stamp is how one tool ends
 * up answering a question another tool would refuse.
 */

export const TicketStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])

export const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export const IdSchema = z.string().uuid()

export const projectFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<void> => {
  if (context.agentKind === 'shared' && context.channel.projectId !== projectId) {
    throw new Error('This agent may work only on the project that owns this channel.')
  }
  if (context.agentKind === 'shared') {
    const binding = await context.prisma.agentBinding.count({
      where: { agentId: context.agentId, channelId: context.channel.id },
    })
    if (binding === 0) {
      throw new Error('This agent is no longer bound to this project channel.')
    }
  }
  if (!(await isProjectAccessibleToUser(context.prisma, member, projectId))) {
    throw new Error('Project not found. Resolve it with project_list first.')
  }
}

export const projectTicketFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  ticketId: string,
): Promise<ProjectTaskRecord> => {
  const ticket = await getProjectTask(context.prisma, ticketId, member.organizationId)
  if (!ticket?.projectId) {
    throw new Error('Ticket not found. Resolve it with ticket_list first.')
  }
  await projectFor(context, member, ticket.projectId)
  return ticket
}

export const recordProjectRead = (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): void => {
  // Owners reach every project by their organization role, so applying a
  // membership-only project basis would withhold this PA reply from its owner.
  if (!member.isOwner) {
    context.consumedSources?.add({ scopeId: projectId, scopeType: 'project' })
  }
}

/**
 * A project write makes model-held material readable to every project reader.
 * Keep this at the shared ticket-write chokepoint so private sources cannot be
 * copied into a task, checklist, or board.
 */
export const assertProjectWriteDestination = async (
  context: BuiltinToolRuntimeContext,
  input: {
    agentId?: string
    organizationId: string
    projectId: string
    taskUserIds?: Array<string | null>
  },
): Promise<void> => {
  const members = await context.prisma.projectMember.findMany({
    where: { projectId: input.projectId },
    select: { userId: true },
  })
  const projectMemberIds = new Set(members.map(({ userId }) => userId))
  const taskUserIds = new Set(input.taskUserIds?.filter((id): id is string => id !== null) ?? [])
  const organizationMembers = await context.prisma.organizationMember.findMany({
    where: { deactivatedAt: null, organizationId: input.organizationId },
    select: { role: true, userId: true },
  })
  const readers = organizationMembers.filter(({ role, userId }) => (
    role === 'owner' || projectMemberIds.has(userId) || taskUserIds.has(userId)
  ))
  const audienceCanSeeAgent = async (agentId: string): Promise<boolean> => {
    const visible = await Promise.all(readers.map(async ({ role, userId }) => (
      isAgentAccessibleToActor(context.prisma, {
        ...context.actorContext,
        actor: { ...context.actorContext.actor, actorId: userId, roles: [role] },
      }, agentId)
    )))
    return !visible.includes(false)
  }
  for (const scope of context.consumedSources?.list() ?? []) {
    const implied = (scope.scopeType === 'organization' && scope.scopeId === input.organizationId)
      || (scope.scopeType === 'project' && scope.scopeId === input.projectId)
      || (scope.scopeType === 'agent' && await audienceCanSeeAgent(scope.scopeId))
    if (!implied) throw new Error('I cannot copy restricted research into this shared project.')
  }
  if (input.agentId && !(await audienceCanSeeAgent(input.agentId))) {
    throw new Error('This content is private to an agent some project collaborators cannot access.')
  }
}

export const ticketLine = (ticket: ProjectTaskRecord): string =>
  [
    `- ${ticket.title ?? 'Untitled'} | ticketId=${ticket.id}`,
    `  status=${ticket.status} priority=${ticket.priority}`,
    `  assignee=${ticket.assigneeName ?? 'unassigned'} due=${ticket.dueDate ?? 'none'}`,
  ].join('\n')

export const result = (
  toolName: string,
  inputSummary: string,
  outputPreview: string,
): ToolExecutionResult => ({ toolName, inputSummary, outputPreview })
