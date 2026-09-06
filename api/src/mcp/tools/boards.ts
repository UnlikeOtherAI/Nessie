import { z } from 'zod'
import { BOARD_TASK_LIMIT } from '@nessie/schemas'
import { findBoard, listBoardTasks, listBoards } from '@nessie/team-admin'

import { createHumanTask, moveTaskToColumn, updateTask } from '../../services/tasks.js'
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

const projectAccess = async (
  context: McpToolContext,
  projectId: string,
): Promise<{ id: string; organizationId: string } | null> => {
  if (!(await context.isProjectAccessibleToActor(context.actorContext, projectId))) {
    return null
  }
  return context.prisma.project.findFirst({
    select: { id: true, organizationId: true },
    where: { id: projectId, organizationId: context.actorContext.tenant.organizationId },
  })
}

/**
 * Where a task lives and whether writing here reaches it, read off the record
 * the service already returned. Stated on every task an agent sees, so it knows
 * before it tries rather than after a change is silently overwritten.
 */
const describeOrigin = (
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
const describeWriteFailure = (
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
      return { error: 'Task not found, or not one this account can reach.', retryable: false }
    case 'COLUMN_NOT_FOUND':
      return { error: "Column not found on this task's board.", retryable: false }
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
        return { error: 'Project not found, or not one this account can reach.' }
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
        return { error: 'Project not found, or not one this account can reach.' }
      }
      const board = await findBoard(context.prisma, project.id, input.boardId as string)
      if (!board) return { error: 'Board not found.' }

      const { tasks, truncated } = await listBoardTasks(context.prisma, board, {
        limit: BOARD_TASK_LIMIT,
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
      + 'be written through Nessie.',
    inputSchema: { taskId: z.string().uuid() },
    name: 'nessie_task_get',
    run: async (context, input) => {
      requireScope(context.scopes, 'boards_read')
      const task = await context.getTask(input.taskId as string)
      if (!task) return { error: 'Task not found, or not one this account can reach.' }
      return { origin: describeOrigin(task.externalLink), task }
    },
  },
  {
    description:
      'Create a task. Creating on a board mirrored from an external system '
      + 'creates it in Nessie only; create it in that system instead if it '
      + 'should exist there.',
    inputSchema: {
      boardId: z.string().uuid().optional(),
      detail: z.string().optional(),
      dueDate: z.string().datetime().optional(),
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
        return { error: 'Project not found, or not one this account can reach.' }
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
      } as Parameters<typeof createHumanTask>[1])

      if ('error' in result) return describeWriteFailure(result)
      return { task: result }
    },
  },
  {
    description:
      'Update a task\'s fields. On a task mirrored from an external system the '
      + 'change is pushed there, or refused if that source is read-only.',
    inputSchema: {
      detail: z.string().optional(),
      dueDate: z.string().datetime().nullable().optional(),
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
        return { error: 'Task not found, or not one this account can reach.' }
      }

      const fields = {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      }
      if (Object.keys(fields).length === 0) {
        return { error: 'No updatable fields were provided.' }
      }

      const result = await updateTask(
        context.prisma,
        {
          fields,
          organizationId: context.actorContext.tenant.organizationId,
          taskId: input.taskId as string,
        } as Parameters<typeof updateTask>[1],
        context.authSecret,
      )
      if ('error' in result) return describeWriteFailure(result)
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
        return { error: 'Task not found, or not one this account can reach.' }
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
        context.authSecret,
      )
      if ('error' in result) return describeWriteFailure(result)
      return { task: result }
    },
  },
]
