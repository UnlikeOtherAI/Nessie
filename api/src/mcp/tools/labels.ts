import { z } from 'zod'
import { TASK_LABEL_NAME_MAX_CHARS, type TaskLabelRecord } from '@nessie/schemas'
import { findProjectLabelBoard, publishProjectBoardUpdated, type BoardRef } from '@nessie/team-admin'

import {
  createBoardLabel,
  deleteBoardLabel,
  isTaskLabelError,
  listBoardLabels,
  listProjectLabels,
  updateBoardLabel,
} from '../../services/task-labels.js'
import { requireScope } from '../scopes.js'
import type { McpToolContext, McpToolDefinition } from '../tool-context.js'
import { describeWriteFailure, PROJECT_NOT_REACHABLE, projectAccess } from './boards.js'

/**
 * A board's labels. A ticket's labels are the labels of the board it is on;
 * `boardId` is optional everywhere, and absent means the project's default
 * board (a create) or every board (a list, a lookup by label id).
 *
 * Unlike the Personal Assistant, a paired agent gets rename, recolour and
 * delete: it has no settings page to send a person to, which is the same
 * reasoning that gave the MCP `nessie_doc_update`. Each tool calls the
 * function the label routes call.
 *
 * Authority is the routes' too. Reading needs the project; changing needs
 * `canModifyProject`, which under the project model is the same predicate as
 * reading (any member, or an organisation owner/admin), so the one
 * `projectAccess` check answers both — as `requireProjectModifier` does.
 * Label management is `boards_write`: a label is board shape, and scopes
 * describe reach, not risk.
 */

const LabelNameSchema = z.string().trim().min(1).max(TASK_LABEL_NAME_MAX_CHARS)
// Accepted in either case; the shared function stores it lower-case.
const LabelColorInputSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb')

const PROVIDER_NAMES: Record<string, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
  trello: 'Trello',
}

/** The provider's display name, for a sentence an agent reads. */
export const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider

/** Cards show label names and colours, so every change repaints the boards. */
const repaint = async (
  context: McpToolContext,
  project: { id: string; organizationId: string },
): Promise<void> => {
  if (!context.realtime) return
  await publishProjectBoardUpdated(context.realtime, {
    organizationId: project.organizationId,
    projectId: project.id,
  })
}

const BOARD_NOT_FOUND = 'Board not found in this project.'

/** The named board of the project, or its default when none is named. */
const projectBoard = async (
  context: McpToolContext,
  projectId: string,
  boardId: string | undefined,
): Promise<BoardRef | null> =>
  context.prisma.board.findFirst({
    where: { projectId, ...(boardId ? { id: boardId } : { isDefault: true }) },
    select: { id: true, projectId: true, organizationId: true },
  })

const nameTaken = (existing: TaskLabelRecord) => ({
  ...describeWriteFailure({ error: 'LABEL_NAME_TAKEN' }),
  label: existing,
})

export const labelTools = (): McpToolDefinition[] => [
  {
    description:
      "List a board's labels — with boardId, that board's; without, every "
      + "board's in the project, each naming its boardId — with its colour, how "
      + 'many tasks carry it, and whether an external source (Linear, Jira, '
      + "GitHub, Trello) owns it. A task's labels are the labels of the board it "
      + 'is on: use that board\'s ids as labelIds on nessie_task_create and nessie_task_update.',
    inputSchema: { boardId: z.string().uuid().optional(), projectId: z.string().uuid() },
    name: 'nessie_label_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) return { error: PROJECT_NOT_REACHABLE }
      if (input.boardId === undefined) {
        return { labels: await listProjectLabels(context.prisma, project.id) }
      }
      const board = await projectBoard(context, project.id, input.boardId as string)
      if (!board) return { error: BOARD_NOT_FOUND }
      return { labels: await listBoardLabels(context.prisma, board.id) }
    },
  },
  {
    description:
      "Create a label on a board — boardId's, or the project's default board "
      + 'when it is omitted. Names are unique on a board ignoring case and '
      + 'surrounding spaces; if the name is taken the board\'s existing label is '
      + 'returned as `label` beside the error, so use that one. `color` is '
      + '#rrggbb; a neutral grey is used when it is omitted.',
    inputSchema: {
      boardId: z.string().uuid().optional(),
      color: LabelColorInputSchema.optional(),
      name: LabelNameSchema,
      projectId: z.string().uuid(),
    },
    name: 'nessie_label_create',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) return { error: PROJECT_NOT_REACHABLE }
      const board = await projectBoard(context, project.id, input.boardId as string | undefined)
      if (!board) return { error: BOARD_NOT_FOUND }
      const result = await createBoardLabel(context.prisma, board, {
        name: input.name as string,
        ...(input.color ? { color: input.color as string } : {}),
        createdByUserId: context.actorContext.actor.actorId,
      })
      if (isTaskLabelError(result)) {
        return result.error === 'LABEL_NAME_TAKEN'
          ? nameTaken(result.existing)
          : describeWriteFailure(result)
      }
      await repaint(context, project)
      return { label: result }
    },
  },
  {
    description:
      'Rename or recolour a label. A label an external source owns can be '
      + 'renamed here, but only in Nessie: the next sync restores the '
      + "provider's name, and the result says so.",
    inputSchema: {
      color: LabelColorInputSchema.optional(),
      labelId: z.string().uuid(),
      name: LabelNameSchema.optional(),
      projectId: z.string().uuid(),
    },
    name: 'nessie_label_update',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) return { error: PROJECT_NOT_REACHABLE }
      if (input.name === undefined && input.color === undefined) {
        return { error: 'Provide a new name, a new color, or both.' }
      }
      const board = await findProjectLabelBoard(
        context.prisma, project.id, input.labelId as string, input.boardId as string | undefined,
      )
      if (!board) return describeWriteFailure({ error: 'LABEL_NOT_FOUND' })
      const result = await updateBoardLabel(context.prisma, board, input.labelId as string, {
        ...(input.name !== undefined ? { name: input.name as string } : {}),
        ...(input.color !== undefined ? { color: input.color as string } : {}),
      })
      if (isTaskLabelError(result)) {
        return result.error === 'LABEL_NAME_TAKEN'
          ? nameTaken(result.existing)
          : describeWriteFailure(result)
      }
      await repaint(context, project)
      if (input.name !== undefined && result.source) {
        const provider = providerName(result.source.provider)
        return {
          label: result,
          warning: `${provider} owns this label's name; the next sync restores it.`,
        }
      }
      return { label: result }
    },
  },
  {
    description:
      "Delete a board's label. It is removed from every task that carries it; "
      + 'the tasks themselves are untouched. The label is found by id in the '
      + 'project; boardId, when given, must be its board.',
    inputSchema: {
      boardId: z.string().uuid().optional(),
      labelId: z.string().uuid(),
      projectId: z.string().uuid(),
    },
    name: 'nessie_label_delete',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) return { error: PROJECT_NOT_REACHABLE }
      const labelId = input.labelId as string
      const board = await findProjectLabelBoard(
        context.prisma, project.id, labelId, input.boardId as string | undefined,
      )
      if (!board) return describeWriteFailure({ error: 'LABEL_NOT_FOUND' })
      // Counted before the delete cascades the links away; the delete itself
      // is the shared function's, and it re-checks the label is this board's.
      const removedFromTasks = await context.prisma.taskLabelLink.count({
        where: { labelId, label: { boardId: board.id } },
      })
      const result = await deleteBoardLabel(context.prisma, board, labelId)
      if ('error' in result) return describeWriteFailure(result)
      await repaint(context, project)
      return { deleted: true, removedFromTasks }
    },
  },
]
