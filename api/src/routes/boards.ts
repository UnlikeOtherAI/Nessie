import type { FastifyInstance } from 'fastify'

import {
  BOARD_TASK_LIMIT,
  BoardColumnRecordSchema,
  BoardRecordSchema,
  CreateBoardBodySchema,
  CreateBoardColumnBodySchema,
  UpdateBoardBodySchema,
  UpdateBoardColumnBodySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  createBoard,
  createBoardColumn,
  deleteBoard,
  deleteBoardColumn,
  findBoard,
  isBoardMutationError,
  listBoardTasks,
  listBoards,
  updateBoard,
  updateBoardColumn,
} from '@nessie/team-admin'

import { BoardTaskRecordSchema } from '../contracts/tasks-board.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * Boards, their columns, and the placed task list a board renders.
 *
 * Replaces the single-board `board.ts`: a project now has many boards, each a
 * saved view over the one task pool. Reads are entitlement-gated on project
 * access; writes need project administration (organisation owner, or the
 * project's own owner/admin) rather than organisation ownership.
 */
export const registerBoardRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireProjectAdmin, isProjectAccessibleToActor } = deps

  const loadProject = async (actorContext: AuthorizedActionContext, projectId: string) => {
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) return null
    return prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, organizationId: true },
    })
  }

  const boardMutationError = (
    reply: Parameters<typeof sendApiError>[0],
    result: { error: string },
  ): void => {
    switch (result.error) {
      case 'BOARD_NOT_FOUND':
        sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
        return
      case 'COLUMN_NOT_FOUND':
        sendApiError(reply, 404, 'COLUMN_NOT_FOUND', 'Column not found')
        return
      case 'BOARD_LAST':
        sendApiError(
          reply,
          409,
          'BOARD_LAST',
          'A project keeps at least one board — rename this one instead of deleting it.',
        )
        return
      case 'BOARD_DEFAULT_REPLACEMENT_REQUIRED':
        sendApiError(
          reply,
          400,
          'BOARD_DEFAULT_REPLACEMENT_REQUIRED',
          'Name the board that becomes the default before deleting this one.',
        )
        return
      default:
        sendApiError(reply, 400, 'BOARD_INVALID', 'Board request refused')
    }
  }

  app.get('/api/projects/:projectId/boards', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const boards = await listBoards(prisma, project)
    return createApiResponse(BoardRecordSchema.array().parse(boards))
  })

  app.post('/api/projects/:projectId/boards', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(CreateBoardBodySchema, request.body, reply)
    if (!body) return reply

    const result = await createBoard(prisma, project, {
      ...body,
      createdByUserId: actorContext.actor.actorId,
    })
    if (isBoardMutationError(result)) {
      boardMutationError(reply, result)
      return reply
    }
    return reply.code(201).send(createApiResponse(BoardRecordSchema.parse(result)))
  })

  app.patch('/api/projects/:projectId/boards/:boardId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(UpdateBoardBodySchema, request.body, reply)
    if (!body) return reply

    const result = await updateBoard(prisma, project.id, boardId, body)
    if (isBoardMutationError(result)) {
      boardMutationError(reply, result)
      return reply
    }
    return createApiResponse(BoardRecordSchema.parse(result))
  })

  app.delete('/api/projects/:projectId/boards/:boardId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const { newDefaultBoardId } = request.query as { newDefaultBoardId?: string }

    const result = await deleteBoard(prisma, project.id, boardId, newDefaultBoardId)
    if (isBoardMutationError(result)) {
      boardMutationError(reply, result)
      return reply
    }
    return createApiResponse({ ok: true })
  })

  // The board's own task list, already placed into columns by the server —
  // the client only groups. A scrum board narrows to the active iteration,
  // because an iteration is a project-level time box any board may ignore.
  app.get('/api/projects/:projectId/boards/:boardId/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const board = await findBoard(prisma, project.id, boardId)
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }

    let iterationId: string | null | undefined
    if (board.style === 'scrum') {
      const active = await prisma.iteration.findFirst({
        where: { projectId: project.id, status: 'active' },
        select: { id: true },
      })
      iterationId = active?.id ?? null
    }
    const { tasks, truncated } = await listBoardTasks(prisma, board, {
      limit: BOARD_TASK_LIMIT,
      iterationId,
    })
    return createApiResponse({
      tasks: BoardTaskRecordSchema.array().parse(tasks),
      truncated,
    })
  })

  app.post('/api/projects/:projectId/boards/:boardId/columns', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const board = await prisma.board.findFirst({
      where: { id: boardId, projectId: project.id },
      select: { id: true, organizationId: true },
    })
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }
    const body = parseInput(CreateBoardColumnBodySchema, request.body, reply)
    if (!body) return reply

    const column = await createBoardColumn(prisma, board, body)
    return reply.code(201).send(createApiResponse(BoardColumnRecordSchema.parse(column)))
  })

  app.patch(
    '/api/projects/:projectId/boards/:boardId/columns/:columnId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const { projectId, boardId, columnId } = request.params as {
        projectId: string
        boardId: string
        columnId: string
      }
      const project = await loadProject(actorContext, projectId)
      if (!project) {
        sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
        return reply
      }
      if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
      if (!(await findBoard(prisma, project.id, boardId))) {
        sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
        return reply
      }
      const body = parseInput(UpdateBoardColumnBodySchema, request.body, reply)
      if (!body) return reply

      const result = await updateBoardColumn(prisma, boardId, columnId, body)
      if (isBoardMutationError(result)) {
        boardMutationError(reply, result)
        return reply
      }
      return createApiResponse(BoardColumnRecordSchema.parse(result))
    },
  )

  app.delete(
    '/api/projects/:projectId/boards/:boardId/columns/:columnId',
    async (request, reply) => {
      const actorContext = requireActorContext(request, reply)
      if (!actorContext) return reply

      const { projectId, boardId, columnId } = request.params as {
        projectId: string
        boardId: string
        columnId: string
      }
      const project = await loadProject(actorContext, projectId)
      if (!project) {
        sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
        return reply
      }
      if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
      if (!(await findBoard(prisma, project.id, boardId))) {
        sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
        return reply
      }

      const result = await deleteBoardColumn(prisma, boardId, columnId)
      if (isBoardMutationError(result)) {
        boardMutationError(reply, result)
        return reply
      }
      return createApiResponse({ ok: true })
    },
  )
}
