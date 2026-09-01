import type { FastifyInstance } from 'fastify'

import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  BoardColumnRecordSchema,
  CreateColumnBodySchema,
  ProjectBoardRecordSchema,
  UpdateBoardBodySchema,
  UpdateColumnBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createColumn,
  deleteColumn,
  getProjectBoard,
  setBoardStyle,
  updateColumn,
} from '../services/board.js'
import type { RouteDeps } from './types.js'

export const registerBoardRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner, isProjectAccessibleToActor } = deps

  // Single seam for every board route: a project is only loadable by an org
  // owner or a member of that project, so one team's board is not readable
  // (or reorderable) by the rest of the organisation.
  const loadProject = async (actorContext: AuthorizedActionContext, projectId: string) => {
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) return null
    return prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, organizationId: true, boardStyle: true },
    })
  }

  app.get('/api/projects/:projectId/board', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const board = await getProjectBoard(prisma, project)
    return createApiResponse(ProjectBoardRecordSchema.parse(board))
  })

  app.patch('/api/projects/:projectId/board', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const body = parseInput(UpdateBoardBodySchema, request.body, reply)
    if (!body) return reply

    await setBoardStyle(prisma, project.id, body.style)
    const board = await getProjectBoard(prisma, { ...project, boardStyle: body.style })
    return createApiResponse(ProjectBoardRecordSchema.parse(board))
  })

  app.post('/api/projects/:projectId/columns', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const body = parseInput(CreateColumnBodySchema, request.body, reply)
    if (!body) return reply

    const column = await createColumn(prisma, project, body)
    return reply.code(201).send(createApiResponse(BoardColumnRecordSchema.parse(column)))
  })

  app.patch('/api/projects/:projectId/columns/:columnId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId, columnId } = request.params as { projectId: string; columnId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const body = parseInput(UpdateColumnBodySchema, request.body, reply)
    if (!body) return reply

    const column = await updateColumn(prisma, project.id, columnId, body)
    if (!column) {
      sendApiError(reply, 404, 'COLUMN_NOT_FOUND', 'Column not found')
      return reply
    }
    return createApiResponse(BoardColumnRecordSchema.parse(column))
  })

  app.delete('/api/projects/:projectId/columns/:columnId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId, columnId } = request.params as { projectId: string; columnId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const deleted = await deleteColumn(prisma, project.id, columnId)
    if (!deleted) {
      sendApiError(reply, 404, 'COLUMN_NOT_FOUND', 'Column not found')
      return reply
    }
    return createApiResponse({ ok: true })
  })
}
