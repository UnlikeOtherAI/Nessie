import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  CreateTaskLabelBodySchema,
  TaskLabelRecordSchema,
  UpdateTaskLabelBodySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { publishProjectBoardUpdated } from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  createProjectLabel,
  deleteProjectLabel,
  isTaskLabelError,
  listProjectLabels,
  updateProjectLabel,
} from '../services/task-labels.js'
import type { RouteDeps } from './types.js'

/**
 * A project's labels. Reading them is reading the project; creating,
 * renaming, recolouring and deleting are changing it (any member, or an
 * organisation owner/admin). Every change repaints the cards through
 * `board.updated`.
 */
export const registerTaskLabelRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    realtimeHub,
    requireActorContext,
    requireUserActor,
    requireProjectModifier,
    isProjectAccessibleToActor,
  } = deps

  const loadProject = async (
    request: FastifyRequest,
    reply: FastifyReply,
    options: { modify: boolean },
  ): Promise<{ actorContext: AuthorizedActionContext; project: { id: string; organizationId: string } } | null> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (!requireUserActor(actorContext, reply)) return null
    const { projectId } = request.params as { projectId: string }
    const project = /^[0-9a-f-]{36}$/i.test(projectId) && (await isProjectAccessibleToActor(actorContext, projectId))
      ? await prisma.project.findFirst({
          where: { id: projectId, organizationId: actorContext.tenant.organizationId, deletedAt: null },
          select: { id: true, organizationId: true },
        })
      : null
    if (!project) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return null
    }
    if (options.modify && !(await requireProjectModifier(actorContext, projectId, reply))) return null
    return { actorContext, project }
  }

  const sendLabelError = (
    reply: FastifyReply,
    result: { error: 'LABEL_NOT_FOUND' } | { error: 'LABEL_NAME_TAKEN'; existing: unknown },
  ): void => {
    if (result.error === 'LABEL_NOT_FOUND') {
      sendApiError(reply, 404, 'LABEL_NOT_FOUND', 'Label not found')
      return
    }
    // The existing label rides along so a picker can select it instead.
    sendApiError(reply, 409, 'LABEL_NAME_TAKEN', 'This project already has a label with that name.', 'name', {
      label: TaskLabelRecordSchema.parse(result.existing),
    })
  }

  const repaint = (project: { id: string; organizationId: string }) =>
    publishProjectBoardUpdated(realtimeHub, { organizationId: project.organizationId, projectId: project.id })

  app.get('/api/projects/:projectId/labels', async (request, reply) => {
    const loaded = await loadProject(request, reply, { modify: false })
    if (!loaded) return reply
    const labels = await listProjectLabels(prisma, loaded.project.id)
    return createApiResponse({ labels: TaskLabelRecordSchema.array().parse(labels) })
  })

  app.post('/api/projects/:projectId/labels', async (request, reply) => {
    const loaded = await loadProject(request, reply, { modify: true })
    if (!loaded) return reply
    const body = parseInput(CreateTaskLabelBodySchema, request.body, reply)
    if (!body) return reply
    const result = await createProjectLabel(prisma, loaded.project, {
      ...body,
      createdByUserId: loaded.actorContext.actor.actorId,
    })
    if (isTaskLabelError(result)) {
      sendLabelError(reply, result)
      return reply
    }
    await repaint(loaded.project)
    return reply.code(201).send(createApiResponse(TaskLabelRecordSchema.parse(result)))
  })

  app.patch('/api/projects/:projectId/labels/:labelId', async (request, reply) => {
    const loaded = await loadProject(request, reply, { modify: true })
    if (!loaded) return reply
    const body = parseInput(UpdateTaskLabelBodySchema, request.body, reply)
    if (!body) return reply
    const { labelId } = request.params as { labelId: string }
    const result = await updateProjectLabel(prisma, loaded.project.id, labelId, body)
    if (isTaskLabelError(result)) {
      sendLabelError(reply, result)
      return reply
    }
    await repaint(loaded.project)
    return createApiResponse(TaskLabelRecordSchema.parse(result))
  })

  app.delete('/api/projects/:projectId/labels/:labelId', async (request, reply) => {
    const loaded = await loadProject(request, reply, { modify: true })
    if (!loaded) return reply
    const { labelId } = request.params as { labelId: string }
    const result = await deleteProjectLabel(prisma, loaded.project.id, labelId)
    if ('error' in result) {
      sendLabelError(reply, result)
      return reply
    }
    await repaint(loaded.project)
    return reply.code(204).send()
  })
}
