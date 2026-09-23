import {
  createBoardLabel,
  isTaskLabelError,
  listBoardLabels,
  listProjectLabels,
  publishProjectBoardUpdated,
  type BoardRef,
} from '@nessie/team-admin'
import { TASK_LABEL_NAME_MAX_CHARS, type TaskLabelRecord } from '@nessie/schemas'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
import { resolveTicketMember } from './ticket-member.js'
import {
  assertProjectWriteDestination,
  IdSchema,
  projectFor,
  recordProjectRead,
  result,
  ticketProjectIdFor,
} from './ticket-context.js'

/**
 * A board's labels: the read that resolves `labelIds` for ticket_create and
 * ticket_update, and creating one. A ticket's labels are the labels of the
 * board it is on; `boardId` is optional and absent means every board (the
 * read) or the project's default board (the create). Renaming, recolouring
 * and deleting are board administration and live on the board's settings
 * page, as the boards design keeps field and source administration off the PA.
 *
 * `projectFor` is the route's `requireProjectModifier`: under the project
 * model the people who may change a project are the people who may read it.
 */

const labelLine = (label: TaskLabelRecord): string =>
  `- ${label.name} | labelId=${label.id} boardId=${label.boardId} color=${label.color}`
  + `${label.source ? ` owned by ${label.source.provider}` : ''}`
  + `${label.taskCount !== undefined ? ` tickets=${label.taskCount}` : ''}`

// An absent projectId is this channel's project (`ticketProjectIdFor`).
const ReadInput = z.object({ projectId: IdSchema.optional(), boardId: IdSchema.optional() })

/** The named board of the project, or its default; refused in words when it is not the project's. */
const boardFor = async (
  context: BuiltinToolRuntimeContext,
  projectId: string,
  boardId: string | undefined,
): Promise<BoardRef & { name: string }> => {
  const board = await context.prisma.board.findFirst({
    where: { projectId, ...(boardId ? { id: boardId } : { isDefault: true }) },
    select: { id: true, projectId: true, organizationId: true, name: true },
  })
  if (!board) throw new Error('Board not found in this project. Read the boards with ticket_board_read.')
  return board
}

export const runTicketLabelsReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const { projectId: named, boardId } = ReadInput.parse(input)
  const projectId = ticketProjectIdFor(context, named)
  const member = await resolveTicketMember(context)
  await projectFor(context, member, projectId)
  if (boardId) {
    const board = await boardFor(context, projectId, boardId)
    const labels = await listBoardLabels(context.prisma, board.id)
    recordProjectRead(context, member, projectId)
    return result(
      'ticket_labels_read',
      `projectId=${projectId} boardId=${boardId}`,
      labels.length
        ? `Labels of board "${board.name}" (${labels.length})\n${labels.map(labelLine).join('\n')}`
        : `Board "${board.name}" has no labels.`,
    )
  }
  const [labels, boards] = await Promise.all([
    listProjectLabels(context.prisma, projectId),
    context.prisma.board.findMany({
      where: { projectId },
      select: { id: true, name: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    }),
  ])
  recordProjectRead(context, member, projectId)
  // Grouped by board: a ticket takes labels of its own board only.
  const sections = boards.flatMap((board) => {
    const own = labels.filter((label) => label.boardId === board.id)
    return own.length ? [`Board "${board.name}" boardId=${board.id}\n${own.map(labelLine).join('\n')}`] : []
  })
  return result(
    'ticket_labels_read',
    `projectId=${projectId}`,
    labels.length
      ? `Labels (${labels.length}); a ticket takes the labels of the board it is on\n${sections.join('\n')}`
      : 'This project has no labels.',
  )
}

const CreateInput = z.object({
  projectId: IdSchema.optional(),
  boardId: IdSchema.optional(),
  name: z.string().trim().min(1).max(TASK_LABEL_NAME_MAX_CHARS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb').optional(),
})

export const runTicketLabelCreateTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const parsed = CreateInput.parse(input)
  const args = { ...parsed, projectId: ticketProjectIdFor(context, parsed.projectId) }
  const member = await resolveActingMember(context)
  await projectFor(context, member, args.projectId)
  await assertProjectWriteDestination(context, {
    organizationId: member.organizationId,
    projectId: args.projectId,
  })
  const board = await boardFor(context, args.projectId, args.boardId)
  const created = await createBoardLabel(context.prisma, board, {
    name: args.name,
    ...(args.color ? { color: args.color } : {}),
    createdByUserId: member.userId,
  })
  if (isTaskLabelError(created)) {
    if (created.error === 'LABEL_NAME_TAKEN') {
      return result(
        'ticket_label_create',
        `projectId=${args.projectId} name="${args.name}"`,
        `Board "${board.name}" already has a label with that name; use it.\n${labelLine(created.existing)}`,
      )
    }
    throw new Error('Label not found.')
  }
  await publishProjectBoardUpdated(context.realtimeTransport, {
    organizationId: member.organizationId,
    projectId: args.projectId,
  })
  return result(
    'ticket_label_create',
    `projectId=${args.projectId} name="${args.name}"`,
    `Created label on board "${board.name}"\n${labelLine(created)}`,
  )
}
