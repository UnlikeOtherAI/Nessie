import type { FastifyInstance } from 'fastify'

import {
  CreateTaskFieldBodySchema,
  TaskFieldDefinitionRecordSchema,
  UpdateTaskFieldBodySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  createTaskFieldDefinition,
  deleteTaskFieldDefinition,
  isTaskFieldError,
  listTaskFieldDefinitions,
  updateTaskFieldDefinition,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * A project's custom task fields. Reading them is part of reading the project;
 * defining them is administering it.
 */
export const registerTaskFieldRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireProjectAdmin, isProjectAccessibleToActor } = deps

  const loadProject = async (actorContext: AuthorizedActionContext, projectId: string) => {
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) return null
    return prisma.project.findFirst({
      where: { id: projectId, organizationId: actorContext.tenant.organizationId },
      select: { id: true, organizationId: true },
    })
  }

  const fieldError = (
    reply: Parameters<typeof sendApiError>[0],
    result: { error: string; name?: string; fieldId?: string; reason?: string },
  ): void => {
    switch (result.error) {
      case 'FIELD_NOT_FOUND':
        sendApiError(reply, 404, 'FIELD_NOT_FOUND', 'Field not found')
        return
      case 'FIELD_NAME_TAKEN':
        sendApiError(
          reply,
          409,
          'FIELD_NAME_TAKEN',
          `This project already has a field called “${result.name ?? ''}”.`,
        )
        return
      case 'FIELD_UNKNOWN':
        sendApiError(reply, 400, 'FIELD_UNKNOWN', 'That field is not defined on this project')
        return
      case 'FIELD_VALUE_INVALID':
        sendApiError(reply, 400, 'FIELD_VALUE_INVALID', `Field value refused: ${result.reason ?? ''}`)
        return
      default:
        sendApiError(reply, 400, 'FIELD_INVALID', 'Field request refused')
    }
  }

  app.get('/api/projects/:projectId/fields', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const definitions = await listTaskFieldDefinitions(prisma, project.id)
    return createApiResponse(TaskFieldDefinitionRecordSchema.array().parse(definitions))
  })

  app.post('/api/projects/:projectId/fields', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(CreateTaskFieldBodySchema, request.body, reply)
    if (!body) return reply

    const result = await createTaskFieldDefinition(prisma, project, {
      ...body,
      createdByUserId: actorContext.actor.actorId,
    })
    if (isTaskFieldError(result)) {
      fieldError(reply, result)
      return reply
    }
    return reply
      .code(201)
      .send(createApiResponse(TaskFieldDefinitionRecordSchema.parse(result)))
  })

  app.patch('/api/projects/:projectId/fields/:fieldId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, fieldId } = request.params as { projectId: string; fieldId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(UpdateTaskFieldBodySchema, request.body, reply)
    if (!body) return reply

    const result = await updateTaskFieldDefinition(prisma, project.id, fieldId, body)
    if (isTaskFieldError(result)) {
      fieldError(reply, result)
      return reply
    }
    return createApiResponse(TaskFieldDefinitionRecordSchema.parse(result))
  })

  app.delete('/api/projects/:projectId/fields/:fieldId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId, fieldId } = request.params as { projectId: string; fieldId: string }
    const project = await loadProject(actorContext, projectId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply

    const result = await deleteTaskFieldDefinition(prisma, project.id, fieldId)
    if (isTaskFieldError(result)) {
      fieldError(reply, result)
      return reply
    }
    return createApiResponse({ ok: true })
  })
}
