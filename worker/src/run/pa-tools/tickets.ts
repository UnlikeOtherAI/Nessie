import {
  archiveProjectDoneTasks,
  assignProjectTask,
  createProjectTask,
  createProjectTaskAssignmentAttention,
  getProjectTask,
  isProjectAccessibleToUser,
  listProjectTasks,
  moveProjectTaskToColumn,
  setProjectTaskIteration,
  transitionProjectTask,
  updateProjectTask,
  type ProjectTaskRecord,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember, type ActingMember } from './access.js'

const TicketStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])
const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
const IdSchema = z.string().uuid()

const projectFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<void> => {
  if (!(await isProjectAccessibleToUser(context.prisma, member, projectId))) {
    throw new Error('Project not found. Resolve it with project_list first.')
  }
}

const projectTicketFor = async (
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

const recordProjectRead = (
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

const ticketLine = (ticket: ProjectTaskRecord): string =>
  [
    `- ${ticket.title ?? 'Untitled'} | ticketId=${ticket.id}`,
    `  status=${ticket.status} priority=${ticket.priority} columnId=${ticket.columnId ?? 'none'}`,
    `  assignee=${ticket.assigneeName ?? 'unassigned'} due=${ticket.dueDate ?? 'none'}`,
  ].join('\n')

const result = (
  toolName: string,
  inputSummary: string,
  outputPreview: string,
): ToolExecutionResult => ({ toolName, inputSummary, outputPreview })

const ListInput = z.object({ projectId: IdSchema, status: TicketStatusSchema.optional() })

export const runTicketListTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ListInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, args.projectId)
  const tickets = await listProjectTasks(context.prisma, member.organizationId, {
    projectId: args.projectId,
    status: args.status,
  })
  recordProjectRead(context, member, args.projectId)
  const output = tickets.length
    ? `Tickets (${tickets.length})\n${tickets.map(ticketLine).join('\n')}`
    : 'No tickets in this project.'
  return result('ticket_list', `projectId=${args.projectId}`, output)
}

const ReadInput = z.object({ ticketId: IdSchema })

export const runTicketReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { ticketId } = ReadInput.parse(input)
  const member = await resolveActingMember(context)
  const ticket = await projectTicketFor(context, member, ticketId)
  recordProjectRead(context, member, ticket.projectId!)
  return result(
    'ticket_read',
    `ticketId=${ticketId}`,
    [
      ticketLine(ticket),
      `Purpose: ${ticket.purpose ?? 'none'}`,
      `Detail: ${ticket.detail ?? 'none'}`,
      `iterationId=${ticket.iterationId ?? 'none'} storyPoints=${ticket.storyPoints ?? 'none'}`,
    ].join('\n'),
  )
}

const BoardInput = z.object({ projectId: IdSchema })

export const runTicketBoardReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { projectId } = BoardInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, projectId)
  const columns = await context.prisma.boardColumn.findMany({
    where: { projectId, organizationId: member.organizationId },
    orderBy: { position: 'asc' },
    select: { id: true, name: true, category: true, position: true },
  })
  recordProjectRead(context, member, projectId)
  const output = columns.length
    ? `Board columns\n${columns.map((column) => (
      `- ${column.name} (${column.category}) | columnId=${column.id} position=${column.position}`
    )).join('\n')}`
    : 'This project has no board columns.'
  return result('ticket_board_read', `projectId=${projectId}`, output)
}

const CreateInput = z.object({
  projectId: IdSchema,
  title: z.string().trim().min(1),
  purpose: z.string().optional(),
  detail: z.string().optional(),
  priority: PrioritySchema.optional(),
  dueDate: z.coerce.date().optional(),
  assigneeUserId: IdSchema.optional(),
  assigneeAgentId: IdSchema.optional(),
})

export const runTicketCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = CreateInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, args.projectId)
  const created = await createProjectTask(context.prisma, {
    ...args,
    actorContext: member.actorContext,
    organizationId: member.organizationId,
    createdByUserId: member.userId,
    assignmentAttention: createProjectTaskAssignmentAttention,
  })
  if ('error' in created) {
    const message = created.error === 'PROJECT_NOT_FOUND' || created.error === 'ITERATION_NOT_FOUND'
      ? 'Project or iteration not found.'
      : 'Assignee or owner is not available to you.'
    throw new Error(message)
  }
  return result(
    'ticket_create',
    `projectId=${args.projectId} title="${args.title}"`,
    `Created ticket\n${ticketLine(created)}`,
  )
}

const UpdateInput = z.object({
  ticketId: IdSchema,
  title: z.string().trim().min(1).optional(),
  purpose: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  priority: PrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
})

export const runTicketUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { ticketId, ...fields } = UpdateInput.parse(input)
  if (Object.keys(fields).length === 0) {
    throw new Error('Provide at least one ticket field to update.')
  }
  const member = await resolveActingMember(context)
  await projectTicketFor(context, member, ticketId)
  const updated = await updateProjectTask(context.prisma, {
    taskId: ticketId,
    organizationId: member.organizationId,
    fields,
  })
  if ('error' in updated) throw new Error('Ticket not found.')
  return result('ticket_update', `ticketId=${ticketId}`, `Updated ticket\n${ticketLine(updated)}`)
}

const AssignInput = z.object({
  ticketId: IdSchema,
  assigneeUserId: IdSchema.optional(),
  assigneeAgentId: IdSchema.optional(),
})

export const runTicketAssignTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = AssignInput.parse(input)
  const member = await resolveActingMember(context)
  await projectTicketFor(context, member, args.ticketId)
  const assigned = await assignProjectTask(context.prisma, {
    taskId: args.ticketId,
    assigneeUserId: args.assigneeUserId,
    assigneeAgentId: args.assigneeAgentId,
    organizationId: member.organizationId,
    actorContext: member.actorContext,
    assignmentAttention: createProjectTaskAssignmentAttention,
  })
  if ('error' in assigned) {
    throw new Error(assigned.error === 'NOT_FOUND' ? 'Ticket not found.' : 'Assignee is not available to you.')
  }
  return result(
    'ticket_assign',
    `ticketId=${args.ticketId}`,
    `Assigned ticket\n${ticketLine(assigned)}`,
  )
}

const MoveInput = z.object({
  ticketId: IdSchema,
  columnId: IdSchema,
  position: z.number().int().min(0).optional(),
})

export const runTicketMoveTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = MoveInput.parse(input)
  const member = await resolveActingMember(context)
  await projectTicketFor(context, member, args.ticketId)
  const moved = await moveProjectTaskToColumn(context.prisma, {
    taskId: args.ticketId,
    columnId: args.columnId,
    position: args.position,
    organizationId: member.organizationId,
    actorId: member.userId,
  })
  if ('error' in moved) {
    if (moved.error === 'COLUMN_NOT_FOUND') {
      throw new Error('Column not found in this ticket’s project. Read the board first.')
    }
    if (moved.error === 'INVALID_TRANSITION') {
      throw new Error(`Cannot move this ticket from ${moved.from ?? 'its current status'} into that column.`)
    }
    throw new Error('Ticket not found.')
  }
  return result(
    'ticket_move',
    `ticketId=${args.ticketId} columnId=${args.columnId}`,
    `Moved ticket\n${ticketLine(moved)}`,
  )
}

const TransitionInput = z.object({ ticketId: IdSchema, status: TicketStatusSchema })

export const runTicketTransitionTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = TransitionInput.parse(input)
  const member = await resolveActingMember(context)
  await projectTicketFor(context, member, args.ticketId)
  const changed = await transitionProjectTask(context.prisma, {
    taskId: args.ticketId,
    status: args.status,
    organizationId: member.organizationId,
    actorId: member.userId,
  })
  if ('error' in changed) {
    if (changed.error === 'NOT_FOUND') throw new Error('Ticket not found.')
    throw new Error(`Cannot transition this ticket from ${changed.from ?? 'its current status'} to ${args.status}.`)
  }
  return result(
    'ticket_transition',
    `ticketId=${args.ticketId} status=${args.status}`,
    `Changed ticket status\n${ticketLine(changed)}`,
  )
}

const IterationInput = z.object({ ticketId: IdSchema, iterationId: IdSchema.nullable() })

export const runTicketIterationSetTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = IterationInput.parse(input)
  const member = await resolveActingMember(context)
  await projectTicketFor(context, member, args.ticketId)
  const updated = await setProjectTaskIteration(context.prisma, {
    taskId: args.ticketId,
    organizationId: member.organizationId,
    iterationId: args.iterationId,
  })
  if ('error' in updated) {
    throw new Error(updated.error === 'ITERATION_NOT_FOUND'
      ? 'Iteration not found in this ticket’s project.'
      : 'Ticket not found.')
  }
  return result(
    'ticket_iteration_set',
    `ticketId=${args.ticketId}`,
    `Updated ticket iteration\n${ticketLine(updated)}`,
  )
}

const ArchiveInput = z.object({
  projectId: IdSchema,
  olderThanDays: z.number().int().positive().optional(),
})

export const runTicketArchiveDoneTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = ArchiveInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, args.projectId)
  const archived = await archiveProjectDoneTasks(context.prisma, {
    ...args,
    organizationId: member.organizationId,
  })
  return result(
    'ticket_archive_done',
    `projectId=${args.projectId}`,
    `Archived ${archived.count} completed ticket${archived.count === 1 ? '' : 's'}.`,
  )
}
