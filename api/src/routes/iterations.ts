import type { FastifyInstance } from 'fastify'

import {
  CreateIterationBodySchema,
  IterationRecordSchema,
  UpdateIterationBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createIteration,
  deleteIteration,
  listIterations,
  updateIteration,
} from '../services/iterations.js'
import type { RouteDeps } from './types.js'

export const registerIterationRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  const loadProject = async (projectId: string, organizationId: string) =>
    prisma.project.findFirst({
      where: { id: projectId, organizationId },
      select: { id: true, organizationId: true },
    })

  // Resolve an iteration to the project it belongs to, scoped to the org.
  const loadIterationProject = async (iterationId: string, organizationId: string) =>
    prisma.iteration.findFirst({
      where: { id: iterationId, organizationId },
      select: { id: true, projectId: true },
    })

  app.get('/api/projects/:projectId/iterations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(projectId, actorContext.tenant.organizationId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const iterations = await listIterations(prisma, project.id)
    return createApiResponse(IterationRecordSchema.array().parse(iterations))
  })

  app.post('/api/projects/:projectId/iterations', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { projectId } = request.params as { projectId: string }
    const project = await loadProject(projectId, actorContext.tenant.organizationId)
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }
    const body = parseInput(CreateIterationBodySchema, request.body, reply)
    if (!body) return reply

    const iteration = await createIteration(prisma, project, body)
    return reply.code(201).send(createApiResponse(IterationRecordSchema.parse(iteration)))
  })

  app.patch('/api/iterations/:iterationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { iterationId } = request.params as { iterationId: string }
    const iteration = await loadIterationProject(iterationId, actorContext.tenant.organizationId)
    if (!iteration) {
      sendApiError(reply, 404, 'ITERATION_NOT_FOUND', 'Iteration not found')
      return reply
    }
    const body = parseInput(UpdateIterationBodySchema, request.body, reply)
    if (!body) return reply

    const result = await updateIteration(prisma, iteration.projectId, iterationId, body)
    if ('error' in result) {
      if (result.error === 'ALREADY_ACTIVE') {
        sendApiError(reply, 409, result.error, 'Another iteration is already active')
        return reply
      }
      sendApiError(reply, 404, 'ITERATION_NOT_FOUND', 'Iteration not found')
      return reply
    }
    return createApiResponse(IterationRecordSchema.parse(result))
  })

  app.delete('/api/iterations/:iterationId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const { iterationId } = request.params as { iterationId: string }
    const iteration = await loadIterationProject(iterationId, actorContext.tenant.organizationId)
    if (!iteration) {
      sendApiError(reply, 404, 'ITERATION_NOT_FOUND', 'Iteration not found')
      return reply
    }

    await deleteIteration(prisma, iteration.projectId, iterationId)
    return createApiResponse({ ok: true })
  })
}
