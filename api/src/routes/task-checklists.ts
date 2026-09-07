import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  ApplyTaskChecklistBodySchema,
  TaskChecklistRecordSchema,
  UpdateTaskChecklistStepBodySchema,
} from '@nessie/schemas'
import {
  applyTaskChecklistTemplate,
  getTaskChecklist,
  publishTaskUpdated,
  updateTaskChecklistStep,
} from '@nessie/team-admin'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { getTask } from '../services/tasks.js'
import type { RouteDeps } from './types.js'

export const registerTaskChecklistRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const requireAccess = async (
    actor: Parameters<RouteDeps['listAccessibleProjectIds']>[0], taskId: string, reply: FastifyReply,
  ) => {
    const projects = await deps.listAccessibleProjectIds(actor)
    const task = await getTask(deps.prisma, taskId, actor.tenant.organizationId,
      projects === 'all' ? undefined : { accessibleProjectIds: projects, actorUserId: actor.actor.actorId })
    if (task) return true
    sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
    return false
  }
  app.get('/api/tasks/:taskId/checklist', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor) return reply
    const { taskId } = request.params as { taskId: string }
    if (!(await requireAccess(actor, taskId, reply))) return reply
    const checklist = await getTaskChecklist(deps.prisma, { organizationId: actor.tenant.organizationId, taskId })
    return createApiResponse(TaskChecklistRecordSchema.nullable().parse(checklist))
  })
  app.post('/api/tasks/:taskId/checklist', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const { taskId } = request.params as { taskId: string }
    const body = parseInput(ApplyTaskChecklistBodySchema, request.body, reply)
    if (!body || !(await requireAccess(actor, taskId, reply))) return reply
    if (!(await deps.isAgentAccessibleToActor(actor, body.agentId))) {
      sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
      return reply
    }
    const checklist = await applyTaskChecklistTemplate(deps.prisma, {
      ...body, createdByUserId: actor.actor.actorId, organizationId: actor.tenant.organizationId, taskId,
    })
    if ('error' in checklist) {
      sendApiError(reply, 404, checklist.error, 'Template not found')
      return reply
    }
    const task = await getTask(deps.prisma, taskId, actor.tenant.organizationId)
    if (task) {
      await publishTaskUpdated(deps.realtimeHub, [{ kind: 'organization', organizationId: actor.tenant.organizationId }], taskId, task.status)
    }
    return reply.code(201).send(createApiResponse(TaskChecklistRecordSchema.parse(checklist)))
  })
  app.patch('/api/tasks/:taskId/checklist/steps/:stepKey', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const { taskId, stepKey } = request.params as { taskId: string; stepKey: string }
    const body = parseInput(UpdateTaskChecklistStepBodySchema, request.body, reply)
    if (!body || !(await requireAccess(actor, taskId, reply))) return reply
    const checklist = await getTaskChecklist(deps.prisma, { organizationId: actor.tenant.organizationId, taskId })
    if (!checklist) {
      sendApiError(reply, 404, 'CHECKLIST_NOT_FOUND', 'Checklist not found')
      return reply
    }
    const updated = await updateTaskChecklistStep(deps.prisma, {
      ...body, checklistId: checklist.id, organizationId: actor.tenant.organizationId, stepKey, taskId,
    })
    if (!updated) {
      sendApiError(reply, 404, 'CHECKLIST_STEP_NOT_FOUND', 'Checklist step not found')
      return reply
    }
    const task = await getTask(deps.prisma, taskId, actor.tenant.organizationId)
    if (task) {
      await publishTaskUpdated(deps.realtimeHub, [{ kind: 'organization', organizationId: actor.tenant.organizationId }], taskId, task.status)
    }
    return createApiResponse(TaskChecklistRecordSchema.parse(updated))
  })
}
