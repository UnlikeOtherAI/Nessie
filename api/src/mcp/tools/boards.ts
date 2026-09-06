import { z } from 'zod'
import { BOARD_TASK_LIMIT } from '@nessie/schemas'
import { findBoard, listBoardTasks, listBoards } from '@nessie/team-admin'

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
 * Where they differ is writes, and the platform already knows it: every task
 * record carries `externalLink` with the provider and its `writeMode`, and the
 * mutating services take a board-source write-back collaborator that refuses a
 * read-only source. These tools therefore surface that fact rather than
 * re-deciding it — a second copy of the rule here could disagree with the one
 * that actually runs.
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
  externalLink: { provider: string; externalUrl: string; writeMode: string } | null,
): Record<string, unknown> =>
  externalLink === null
    ? { kind: 'internal', writable: true }
    : {
        kind: 'mirrored',
        provider: externalLink.provider,
        url: externalLink.externalUrl,
        writable: externalLink.writeMode === 'read_write',
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
      const task = await context.getTask(context.prisma, {
        actorContext: context.actorContext,
        taskId: input.taskId as string,
      })
      if (!task) return { error: 'Task not found, or not one this account can reach.' }
      return { origin: describeOrigin(task.externalLink), task }
    },
  },
]
