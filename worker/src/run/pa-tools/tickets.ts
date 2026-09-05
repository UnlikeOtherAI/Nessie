import {
  archiveProjectDoneTasks,
  assignProjectTask,
  createProjectTask,
  createProjectTaskAssignmentAttention,
  getProjectTask,
  isProjectAccessibleToUser,
  listBoards,
  listTaskFieldDefinitions,
  listProjectTasks,
  createBoardSourceWriteBack,
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
    `  status=${ticket.status} priority=${ticket.priority}`,
    `  assignee=${ticket.assigneeName ?? 'unassigned'} due=${ticket.dueDate ?? 'none'}`,
  ].join('\n')

const result = (
  toolName: string,
  inputSummary: string,
  outputPreview: string,
): ToolExecutionResult => ({ toolName, inputSummary, outputPreview })

/**
 * The write-back collaborator, built from the same registry the API uses so the
 * assistant reaches a provider exactly as a person's click does — and gets the
 * same refusal (personal-assistant-tools.md: a tool that does what a person
 * does by clicking calls the function that person's button calls).
 */
const writeBackFor = (context: BuiltinToolRuntimeContext) =>
  context.boardSourceEncryptionSecret
    ? createBoardSourceWriteBack({
        prisma: context.prisma,
        encryptionSecret: context.boardSourceEncryptionSecret,
      })
    : undefined

/** A source refusal, said in words rather than as a code. */
const throwIfSourceRefused = (outcome: { error?: string; detail?: string }): void => {
  if (
    outcome.error === 'SOURCE_READ_ONLY' ||
    outcome.error === 'SOURCE_REJECTED' ||
    outcome.error === 'ASSIGNEE_NOT_LINKED' ||
    outcome.error === 'SOURCE_UNAVAILABLE'
  ) {
    throw new Error(outcome.detail ?? 'The source refused that change.')
  }
}

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

// Mirrors `GET /api/projects/:projectId/boards`: a project has many boards,
// and a `columnId` only means something together with the board it is on.
export const runTicketBoardReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { projectId } = BoardInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, projectId)
  const boards = await listBoards(context.prisma, {
    id: projectId,
    organizationId: member.organizationId,
  })
  recordProjectRead(context, member, projectId)
  const output = boards.length
    ? boards
        .map((board) =>
          [
            `Board "${board.name}" | boardId=${board.id} style=${board.style}${
              board.isDefault ? ' (default)' : ''
            } — owns its own tickets`,
            ...board.columns.map(
              (column) =>
                `  - ${column.name} (${column.category}) | columnId=${column.id} position=${column.position}`,
            ),
          ].join('\n'),
        )
        .join('\n')
    : 'This project has no boards.'
  return result('ticket_board_read', `projectId=${projectId}`, output)
}

const CreateInput = z.object({
  projectId: IdSchema,
  /** From `ticket_board_read`; absent lands the card on the default board. */
  boardId: IdSchema.optional(),
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
    const message =
      created.error === 'PROJECT_NOT_FOUND' ||
      created.error === 'ITERATION_NOT_FOUND' ||
      created.error === 'BOARD_NOT_FOUND'
        ? 'Project, board or iteration not found.'
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
  fieldValues: z.record(z.string(), z.unknown()).optional(),
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
  const updated = await updateProjectTask(
    context.prisma,
    { taskId: ticketId, organizationId: member.organizationId, fields },
    writeBackFor(context),
  )
  if ('error' in updated) {
    throwIfSourceRefused(updated)
    // A refused custom field says which one and why, so the model can correct
    // it rather than retry the same value.
    if (updated.error === 'FIELD_UNKNOWN') {
      throw new Error(
        'That field is not defined on this project. Read ticket_fields_read first.',
      )
    }
    if (updated.error === 'FIELD_VALUE_INVALID') {
      throw new Error(`Field value refused: ${updated.reason}`)
    }
    throw new Error('Ticket not found.')
  }
  return result('ticket_update', `ticketId=${ticketId}`, `Updated ticket\n${ticketLine(updated)}`)
}

const FieldsInput = z.object({ projectId: IdSchema })

/**
 * Mirrors `GET /api/projects/:projectId/fields`. A `select` field's value is an
 * option id rather than its label, so the model has to be able to read the ids
 * instead of guessing them from what a card shows.
 */
export const runTicketFieldsReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { projectId } = FieldsInput.parse(input)
  const member = await resolveActingMember(context)
  await projectFor(context, member, projectId)
  const definitions = await listTaskFieldDefinitions(context.prisma, projectId)
  recordProjectRead(context, member, projectId)
  const output = definitions.length
    ? definitions
        .map((definition) => {
          const options = definition.options
            .filter((option) => !option.retiredAt)
            .map((option) => `${option.label}=${option.id}`)
            .join(', ')
          return [
            `- ${definition.name} (${definition.type}) | fieldId=${definition.id}`,
            options ? `  options: ${options}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        })
        .join('\n')
    : 'This project has no custom ticket fields.'
  return result('ticket_fields_read', `projectId=${projectId}`, output)
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
  const assigned = await assignProjectTask(
    context.prisma,
    {
      taskId: args.ticketId,
      assigneeUserId: args.assigneeUserId,
      assigneeAgentId: args.assigneeAgentId,
      organizationId: member.organizationId,
      actorContext: member.actorContext,
      assignmentAttention: createProjectTaskAssignmentAttention,
    },
    writeBackFor(context),
  )
  if ('error' in assigned) {
    throwIfSourceRefused(assigned)
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
  const moved = await moveProjectTaskToColumn(
    context.prisma,
    {
      taskId: args.ticketId,
      columnId: args.columnId,
      position: args.position,
      organizationId: member.organizationId,
      actorId: member.userId,
    },
    writeBackFor(context),
  )
  if ('error' in moved) {
    throwIfSourceRefused(moved)
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
