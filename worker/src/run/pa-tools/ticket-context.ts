import type { ProjectTaskRecord } from '@nessie/team-admin'
import { getProjectTask, isAgentAccessibleToActor, isProjectAccessibleToUser } from '@nessie/team-admin'
import { canUserReadRunDerivedRecord, runCarriesDisclosureBasis } from '@nessie/runtime'
import { z } from 'zod'

import { isTicketWorkRun, TICKET_WORK_HOST_OUTPUT_REFUSAL } from '../execute/ticket-work-setup.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import type { TicketMember } from './ticket-member.js'

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
 * Personal Assistant's. Not `channel_list` either: it names a channel's
 * project, never its id, so the agent was left guessing a UUID.
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
  member: TicketMember,
  projectId: string,
): Promise<void> => {
  if (context.agentKind === 'shared' && context.channel.projectId !== projectId) {
    throw new Error(
      'This agent may work only on the project that owns this channel. '
      + 'Omit projectId to use it.',
    )
  }
  if (member.userId === null) {
    // An agent with no person behind it reaches a project only through its
    // own live binding to one of that project's channels: this one.
    const binding = await context.prisma.agentBinding.count({
      where: {
        agentId: context.agentId,
        channel: { id: context.channel.id, projectId, deletedAt: null, archivedAt: null, project: { deletedAt: null } },
      },
    })
    if (binding > 0) return
    const agent = await context.prisma.agent.findUnique({ where: { id: context.agentId }, select: { name: true } })
    throw new Error(`${agent?.name ?? 'This agent'} is no longer in a channel of this project.`)
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

/**
 * Whether this member may read a ticket some run derived. A person reads it
 * when they can read that run; an agent with no person behind it only when
 * the run carries no disclosure basis at all, because nobody's reach vouches
 * for what a restricted run drew on.
 */
export const canTicketMemberReadRunDerived = async (
  context: BuiltinToolRuntimeContext,
  member: TicketMember,
  runId: string | null,
): Promise<boolean> => member.userId === null
  ? !(await runCarriesDisclosureBasis(context.prisma, runId))
  : canUserReadRunDerivedRecord(context.prisma, {
      organizationId: member.organizationId,
      runId,
      uoaIdentity: context.actorContext.actionContext.uoaIdentity,
      userId: member.userId,
    })

export const projectTicketFor = async (
  context: BuiltinToolRuntimeContext,
  member: TicketMember,
  ticketId: string,
): Promise<ProjectTaskRecord> => {
  const ticket = await getProjectTask(context.prisma, ticketId, member.organizationId)
  if (!ticket?.projectId || !(await canTicketMemberReadRunDerived(context, member, ticket.runId ?? null))) {
    throw new Error('Ticket not found. Resolve it with ticket_list first.')
  }
  await projectFor(context, member, ticket.projectId)
  return ticket
}

export const recordProjectRead = (
  context: BuiltinToolRuntimeContext,
  member: TicketMember,
  projectId: string,
): void => {
  // Owners reach every project by their organization role, so applying a
  // membership-only project basis would withhold this PA reply from its owner.
  if (!member.isOwner) {
    context.consumedSources?.add({ scopeId: projectId, scopeType: 'project' })
  }
}

/**
 * The host-output launch channels among `scopes` that every reader of this
 * project can already read: a live, ordinary, public channel of this very
 * project.
 *
 * Only a host-output stamp is a candidate (`addHostOutputScope`): launching
 * local apps in a public project channel is consent to show the program's
 * output to that room, whose audience contains the board's. The same channel
 * scope from any other source — a recalled memory's channel audience, say —
 * stays refused, as it was before host output existed.
 *
 * Structural, like the rest of the disclosure machinery: a public standard
 * channel is readable by every active organisation member
 * (`buildAccessibleChannelWhere`), and every project reader is one. A
 * protected channel is read by its members alone, a private one is a DM or a
 * system room, and a channel of another project says nothing about this one
 * — all stay refused. So does a channel that carries private-conversation
 * lineage: its authors decide its export, whatever the channel has become
 * since.
 */
const projectWideLaunchChannelIds = async (
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
 * One channel scope is implied: the channel local apps were launched in, as a
 * host-output stamp, when it is a public channel of this project. That is how
 * a local program's output reaches that project's board
 * (`executor-host-output.ts`).
 */
export const assertProjectWriteDestination = async (
  context: BuiltinToolRuntimeContext,
  input: {
    agentId?: string
    /**
     * What is written: a comment on one ticket. A `ticket.work` run that has
     * read its machine's output writes only a comment on its own ticket.
     */
    destination?: { kind: 'ticket_comment'; taskId: string }
    organizationId: string
    projectId: string
    taskUserIds?: Array<string | null>
  },
): Promise<void> => {
  if (isTicketWorkRun(context.actorContext) && (context.consumedSources?.hostOutputScopes().length ?? 0) > 0) {
    const workId = context.actorContext.actionContext.ticketWorkId
    const work = workId
      ? await context.prisma.agentTicketWork.findUnique({ where: { id: workId }, select: { taskId: true } })
      : null
    if (!work || input.destination?.kind !== 'ticket_comment' || input.destination.taskId !== work.taskId) {
      throw new Error(TICKET_WORK_HOST_OUTPUT_REFUSAL)
    }
  }
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
  const launchChannels = await projectWideLaunchChannelIds(
    context,
    input,
    context.consumedSources?.hostOutputScopes() ?? [],
  )
  for (const scope of consumed) {
    const implied = (scope.scopeType === 'organization' && scope.scopeId === input.organizationId)
      || (scope.scopeType === 'project' && scope.scopeId === input.projectId)
      || (scope.scopeType === 'channel' && launchChannels.has(scope.scopeId))
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
