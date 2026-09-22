import type { ProjectTaskRecord } from '@nessie/team-admin'
import { getProjectTask, isAgentAccessibleToActor, isProjectAccessibleToUser } from '@nessie/team-admin'
import { canUserReadRunDerivedRecord } from '@nessie/runtime'
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

/**
 * The project a ticket tool acts on when the model names none.
 *
 * A shared agent is lent these tools only in its own project channel, and
 * `projectFor` refuses every other project, so the one id it could pass is
 * already on the run — and `project_list`, the tool that would find it, is the
 * Personal Assistant's. Not `channel_list` either: that read stamps the run's
 * disclosure basis and would then block the very write it was resolving for.
 * The Personal Assistant works across projects, so it still names one.
 */
export const ticketProjectIdFor = (
  context: BuiltinToolRuntimeContext,
  projectId: string | undefined,
): string => {
  if (projectId) return projectId
  if (context.agentKind === 'shared' && context.channel.projectId) return context.channel.projectId
  throw new Error(
    context.agentKind === 'shared'
      ? 'This conversation is not in a project channel, so there is no board to work on here.'
      : 'Name the projectId. Resolve it with project_list first.',
  )
}

export const projectFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<void> => {
  if (context.agentKind === 'shared' && context.channel.projectId !== projectId) {
    throw new Error(
      'This agent may work only on the project that owns this channel. '
      + 'Omit projectId to use it.',
    )
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
    // A shared agent holds no project_list, and its project is fixed by the
    // channel: what failed is the requester's own access, so say that.
    throw new Error(
      context.agentKind === 'shared'
        ? 'The person you are working for cannot open this project, so its board is closed to this conversation.'
        : 'Project not found. Resolve it with project_list first.',
    )
  }
}

export const projectTicketFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  ticketId: string,
): Promise<ProjectTaskRecord> => {
  const ticket = await getProjectTask(context.prisma, ticketId, member.organizationId)
  if (!ticket?.projectId || !(await canUserReadRunDerivedRecord(context.prisma, {
    organizationId: member.organizationId,
    runId: ticket.runId ?? null,
    uoaIdentity: context.actorContext.actionContext.uoaIdentity,
    userId: member.userId,
  }))) {
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
