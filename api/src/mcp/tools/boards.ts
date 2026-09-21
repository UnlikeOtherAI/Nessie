import { z } from 'zod'
import { BOARD_TASK_LIMIT, TaskLabelIdsSchema, type TaskStatus } from '@nessie/schemas'
import { findBoard, listBoards, publishTaskUpdated } from '@nessie/team-admin'

import { taskActorFromContext } from '../../services/task-labels.js'
import { listTaskAttachments } from '../../services/task-attachments.js'
import {
  createHumanTask,
  listBoardTasksForUser,
  moveTaskToColumn,
  updateTask,
} from '../../services/tasks.js'
import { requireScope } from '../scopes.js'
import type { McpToolContext, McpToolDefinition } from '../tool-context.js'

/**
 * Boards, whichever system they came from.
 *
 * A Linear-backed board is not a separate kind of thing here: `BoardSource`
 * mirrors its issues into ordinary `Task` rows through `TaskExternalLink`, so
 * one tool set covers both and there is deliberately no `nessie_linear_*`
 * family to keep in step with this one.
 *
 * Where they differ is writes, and the platform already knows it. Every task
 * record carries `externalLink` with the provider and its `writeMode`, and the
 * mutating services take a board-source write-back collaborator that pushes the
 * change upstream or refuses with `SOURCE_READ_ONLY`. These tools surface that
 * decision rather than re-deriving it — a second copy of the rule here could
 * disagree with the one that actually runs, and the disagreement would look
 * like a write that succeeded and then vanished at the next sync.
 */

/** The one sentence every unreachable id gets, so an agent cannot tell "absent" from "not yours". */
export const TASK_NOT_REACHABLE = 'Task not found, or not one this account can reach.'
export const PROJECT_NOT_REACHABLE = 'Project not found, or not one this account can reach.'

/**
 * What an agent is told about a ticket's text. A description and a comment are
 * Markdown, and an image inside one is an attachment of the ticket referenced
 * by its path — the same path a person's editor writes.
 */
export const MARKDOWN_NOTE =
  'Descriptions and comments are Markdown. To show an image inline, upload it '
  + 'with nessie_task_attachment_add and write `![alt](/api/attachments/<attachmentId>)`.'

export const projectAccess = async (
  context: McpToolContext,
  projectId: string,
): Promise<{ id: string; organizationId: string } | null> => {
  if (!(await context.isProjectAccessibleToActor(context.actorContext, projectId))) {
    return null
  }
  return context.prisma.project.findFirst({
    select: { id: true, organizationId: true },
    where: {
      id: projectId,
      organizationId: context.actorContext.tenant.organizationId,
      deletedAt: null,
    },
  })
}

/**
 * Where a task lives and whether writing here reaches it, read off the record
 * the service already returned. Stated on every task an agent sees, so it knows
 * before it tries rather than after a change is silently overwritten.
 */
export const describeOrigin = (
  externalLink?: { provider: string; externalUrl: string; writeMode: string } | null,
): Record<string, unknown> =>
  !externalLink
    ? { kind: 'internal', writable: true }
    : {
        kind: 'mirrored',
        provider: externalLink.provider,
        url: externalLink.externalUrl,
        writable: externalLink.writeMode === 'read_write',
      }

/**
 * Turn a service refusal into something an agent can act on.
 *
 * The write-back collaborator already distinguishes "this source is read-only"
 * from "the provider rejected it" from "the provider is unreachable", and those
 * call for different behaviour: stop, change the request, or retry later. A
 * single generic failure would flatten all three.
 */
export const describeWriteFailure = (
  result: { error: string; detail?: string; reason?: string },
): { error: string; code: string; retryable: boolean } => ({
  code: result.error,
  ...describeFailure(result),
})

const describeFailure = (
  result: { error: string; detail?: string; reason?: string },
): { error: string; retryable: boolean } => {
  switch (result.error) {
    case 'SOURCE_READ_ONLY':
      return {
        error:
          result.detail
          ?? 'That board mirrors an external system and is read-only here. '
            + 'Make the change in that system; it syncs back.',
        retryable: false,
      }
    case 'SOURCE_REJECTED':
      return {
        error: result.detail ?? 'The external system refused that change.',
        retryable: false,
      }
    case 'ASSIGNEE_NOT_LINKED':
      return {
        error:
          result.detail
          ?? 'That assignee has no linked account in the external system.',
        retryable: false,
      }
    case 'SOURCE_UNAVAILABLE':
      return {
        error: result.detail ?? 'The external system could not be reached.',
        retryable: true,
      }
    case 'FIELD_UNKNOWN':
      return { error: 'That field is not defined on this project.', retryable: false }
    case 'FIELD_VALUE_INVALID':
      return { error: `Field value refused: ${result.reason ?? 'invalid'}`, retryable: false }
    case 'NOT_FOUND':
      return { error: TASK_NOT_REACHABLE, retryable: false }
    case 'COLUMN_NOT_FOUND':
      return { error: "Column not found on this task's board.", retryable: false }
    case 'LABEL_NOT_ON_BOARD':
      return {
        error: "That label is not on this task's board. Read them with nessie_label_list.",
        retryable: false,
      }
    case 'LABEL_NOT_IN_TASK_SOURCE':
      return {
        error: 'That label belongs to a different external source than this task, so it cannot be set here.',
        retryable: false,
      }
    case 'LABEL_NAME_TAKEN':
      return { error: 'This board already has a label with that name; use it.', retryable: false }
    case 'LABEL_NOT_FOUND':
      return { error: 'Label not found in this project (or not on that board).', retryable: false }
    case 'COMMENT_NOT_FOUND':
      return { error: 'Comment not found on this task.', retryable: false }
    case 'COMMENT_NOT_AUTHOR':
      return { error: 'Only its author can change a comment.', retryable: false }
    case 'COMMENT_NOT_WRITABLE':
      return {
        error: 'This comment came from an external system that cannot change it from Nessie.',
        retryable: false,
      }
    case 'CURSOR_INVALID':
      return { error: 'That cursor is not one this list returned.', retryable: false }
    case 'ATTACHMENT_NOT_ON_TASK':
      return { error: 'That attachment is not on this task.', retryable: false }
    case 'ATTACHMENT_NOT_REMOVABLE':
      return {
        error: 'That file is a copy the external source keeps; it cannot be removed here.',
        retryable: false,
      }
    case 'ATTACHMENT_ALREADY_REMOVED':
      return { error: 'That file is already marked as removed.', retryable: false }
    case 'ATTACHMENT_TOO_LARGE':
      return { error: result.detail ?? 'That file is too large to attach.', retryable: false }
    default:
      return { error: `That change was refused: ${result.error}`, retryable: false }
  }
}

export const boardTools = (): McpToolDefinition[] => [
  {
    description:
      'List the boards in a project. Covers boards whose tasks originate in '
      + 'Nessie and boards mirrored from Linear, Jira, GitHub or Trello alike.',
    inputSchema: { projectId: z.string().uuid() },
    name: 'nessie_board_list',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) {
        return { error: PROJECT_NOT_REACHABLE }
      }
      return { boards: await listBoards(context.prisma, project) }
    },
  },
  {
    description:
      'Read one board: its columns and the tasks on it. Each task reports '
      + 'whether it is native to Nessie or mirrored from an external system, '
      + 'and whether writes through Nessie reach that system.',
    inputSchema: {
      boardId: z.string().uuid(),
      projectId: z.string().uuid(),
    },
    name: 'nessie_board_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const project = await projectAccess(context, input.projectId as string)
      if (!project) {
        return { error: PROJECT_NOT_REACHABLE }
      }
      const board = await findBoard(context.prisma, project.id, input.boardId as string)
      if (!board) return { error: 'Board not found.' }

      // The same viewer-scoped disclosure as the board route and `nessie_task_get`.
      const { tasks, truncated } = await listBoardTasksForUser(context.prisma, board, {
        limit: BOARD_TASK_LIMIT,
      }, {
        organizationId: context.actorContext.tenant.organizationId,
        uoaIdentity: context.actorContext.actionContext.uoaIdentity,
        userId: context.actorContext.actor.actorId,
      })
      return {
        board,
        tasks: tasks.map((task) => ({ ...task, origin: describeOrigin(task.externalLink) })),
        truncated,
      }
    },
  },
  {
    description:
      'Read one task by id, including where it originates and whether it can '
      + 'be written through Nessie, its labels, its attachments and how many '
      + 'comments it has (read them with nessie_task_comment_list). `task.detail` '
      + `is the description. ${MARKDOWN_NOTE}`,
    inputSchema: { taskId: z.string().uuid() },
    name: 'nessie_task_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const task = await context.getTask(input.taskId as string)
      if (!task) return { error: TASK_NOT_REACHABLE }
      const files = await listTaskAttachments(
        context.prisma,
        taskActorFromContext(context.actorContext),
        { taskId: task.id },
      )
      return {
        origin: describeOrigin(task.externalLink),
        task,
        labels: task.labels ?? [],
        attachments: 'error' in files ? [] : files.attachments,
        commentCount: task.commentCount ?? 0,
      }
    },
  },
  {
    description:
      'Create a task. Creating on a board mirrored from an external system '
      + 'creates it in Nessie only; create it in that system instead if it '
      + 'should exist there. `detail` is the description; labelIds come from '
      + `nessie_label_list. ${MARKDOWN_NOTE}`,
    inputSchema: {
      boardId: z.string().uuid().optional(),
      detail: z.string().optional(),
      dueDate: z.string().datetime().optional(),
      labelIds: TaskLabelIdsSchema.optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      projectId: z.string().uuid(),
      purpose: z.string().optional(),
      title: z.string().min(1),
    },
    name: 'nessie_task_create',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      // A project id is not an organisation-wide capability: creation is
      // limited to the caller's own project entitlement, as the route has it.
      const project = await projectAccess(context, input.projectId as string)
      if (!project) {
        return { error: PROJECT_NOT_REACHABLE }
      }

      const result = await createHumanTask(context.prisma, {
        actorContext: context.actorContext,
        createdByUserId: context.actorContext.actor.actorId,
        organizationId: context.actorContext.tenant.organizationId,
        projectId: input.projectId as string,
        title: input.title as string,
        ...(input.boardId ? { boardId: input.boardId as string } : {}),
        ...(input.detail ? { detail: input.detail as string } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate as string } : {}),
        ...(input.priority ? { priority: input.priority as 'low' } : {}),
        ...(input.purpose ? { purpose: input.purpose as string } : {}),
        ...(input.labelIds ? { labelIds: input.labelIds as string[] } : {}),
      } as Parameters<typeof createHumanTask>[1])

      if ('error' in result) return describeWriteFailure(result)
      return { task: result }
    },
  },
  {
    description:
      'Update a task\'s fields. On a task mirrored from an external system the '
      + 'change is pushed there, or refused if that source is read-only. '
      + '`labelIds` replaces the whole label set (ids from nessie_label_list; '
      + `an empty list clears it). \`detail\` is the description. ${MARKDOWN_NOTE}`,
    inputSchema: {
      detail: z.string().optional(),
      dueDate: z.string().datetime().nullable().optional(),
      labelIds: TaskLabelIdsSchema.optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      purpose: z.string().optional(),
      taskId: z.string().uuid(),
      title: z.string().min(1).optional(),
    },
    name: 'nessie_task_update',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      // Reachability first: the mutation itself is org-scoped, so without this
      // a task id from a project this account cannot see would still be edited.
      if (!(await context.getTask(input.taskId as string))) {
        return { error: TASK_NOT_REACHABLE }
      }

      const fields = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
      }
      if (Object.keys(fields).length === 0) {
        return { error: 'No updatable fields were provided.' }
      }

      const result = await updateTask(
        context.prisma,
        {
          actorId: context.actorContext.actor.actorId,
          fields,
          organizationId: context.actorContext.tenant.organizationId,
          taskId: input.taskId as string,
        } as Parameters<typeof updateTask>[1],
        context.encryptionKeyRing,
      )
      if ('error' in result) return describeWriteFailure(result)
      // The PATCH route announces the change; an agent's edit must repaint an
      // open board and dialog the same way.
      if (context.realtime) {
        await publishTaskUpdated(context.realtime, [
          { kind: 'organization', organizationId: context.actorContext.tenant.organizationId },
        ], result.id, result.status as TaskStatus)
      }
      return { task: result }
    },
  },
  {
    description:
      'Move a task to another column on its board. On a mirrored task the '
      + 'matching state change is pushed to the external system, or refused if '
      + 'that source is read-only.',
    inputSchema: {
      columnId: z.string().uuid(),
      position: z.number().int().optional(),
      taskId: z.string().uuid(),
    },
    name: 'nessie_task_move',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_write')
      if (!(await context.getTask(input.taskId as string))) {
        return { error: TASK_NOT_REACHABLE }
      }

      const result = await moveTaskToColumn(
        context.prisma,
        {
          actorId: context.actorContext.actor.actorId,
          columnId: input.columnId as string,
          organizationId: context.actorContext.tenant.organizationId,
          taskId: input.taskId as string,
          ...(input.position !== undefined ? { position: input.position as number } : {}),
        } as Parameters<typeof moveTaskToColumn>[1],
        context.encryptionKeyRing,
      )
      if ('error' in result) return describeWriteFailure(result)
      return { task: result }
    },
  },
]
