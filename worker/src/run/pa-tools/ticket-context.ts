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
 * The channel scopes among `scopes` that every reader of this project can
 * already read: a live, ordinary, public channel of this very project.
 *
 * Structural, like the rest of the disclosure machinery: a public standard
 * channel is readable by every active organisation member
 * (`buildAccessibleChannelWhere`), and every project reader is one, so its
 * audience contains the board's. A protected channel is read by its members
 * alone, a private one is a DM or a system room, and a channel of another
 * project says nothing about this one — all stay refused. So does a channel
 * that carries private-conversation lineage: its authors decide its export,
 * whatever the channel has become since.
 */
const projectWideChannelIds = async (
  context: BuiltinToolRuntimeContext,
  input: { organizationId: string; projectId: string },
  scopes: readonly { scopeId: string; scopeType: string }[],
): Promise<Set<string>> => {
  const lineage = new Set(
    (context.consumedSources?.privateConversationSources() ?? []).map(({ sourceChannelId }) => sourceChannelId),
  )
  const candidates = [...new Set(scopes.flatMap((scope) => (
    scope.scopeType === 'channel' && !lineage.has(scope.scopeId) ? [scope.scopeId] : []
  )))]
  if (candidates.length === 0) return new Set()
  const channels = await context.prisma.channel.findMany({
    where: {
      deletedAt: null,
      id: { in: candidates },
      organizationId: input.organizationId,
      projectId: input.projectId,
      systemChannelType: null,
      type: 'standard',
      visibility: 'public',
    },
    select: { id: true },
  })
  return new Set(channels.map(({ id }) => id))
}

/**
 * A project write makes model-held material readable to every project reader.
 * Keep this at the shared ticket-write chokepoint so private sources cannot be
 * copied into a task, checklist, or board.
 *
 * One channel scope is implied: a public channel of this project, which is
 * how a local program's output, stamped with the channel it was launched in,
 * reaches that project's board (`executor-host-output.ts`).
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
  const consumed = context.consumedSources?.list() ?? []
  const projectWideChannels = await projectWideChannelIds(context, input, consumed)
  for (const scope of consumed) {
    const implied = (scope.scopeType === 'organization' && scope.scopeId === input.organizationId)
      || (scope.scopeType === 'project' && scope.scopeId === input.projectId)
      || (scope.scopeType === 'channel' && projectWideChannels.has(scope.scopeId))
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
