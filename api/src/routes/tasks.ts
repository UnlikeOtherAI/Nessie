import type { FastifyInstance } from 'fastify'

import { type AuthorizedActionContext, ProjectIdSchema, TaskStatusSchema } from '@nessie/schemas'
import {
  AssignableUserSchema,
  AssignTaskBodySchema,
  CreateTaskBodySchema,
  MoveTaskBodySchema,
  SetTaskIterationBodySchema,
  TaskRecordSchema,
  TransitionTaskBodySchema,
  UpdateTaskBodySchema,
} from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  assignTask,
  createHumanTask,
  getTask,
  listAssignableUsers,
  listTasks,
  moveTaskToColumn,
  setTaskIteration,
  transitionTask,
  updateTask,
} from '../services/tasks.js'
import type { RouteDeps } from './types.js'

export const registerTaskRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  const resolveTaskUserFilter = (
    value: string | undefined,
    actorContext: AuthorizedActionContext,
  ): string | undefined => {
    if (!value) return undefined
    return value === 'me' ? actorContext.actor.actorId : value
  }

  app.get('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const statusFilter = TaskStatusSchema.safeParse(query['status'])
    const projectFilter = ProjectIdSchema.safeParse(query['project'])
    const tasks = await listTasks(prisma, actorContext.tenant.organizationId, {
      assigneeUserId: resolveTaskUserFilter(query['assignee'], actorContext),
      ownerUserId: resolveTaskUserFilter(query['owner'], actorContext),
      status: statusFilter.success ? statusFilter.data : undefined,
      projectId: projectFilter.success ? projectFilter.data : undefined,
    })
    return createApiResponse(TaskRecordSchema.array().parse(tasks))
  })

  app.get('/api/tasks/assignees', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const users = await listAssignableUsers(prisma, actorContext.tenant.organizationId)
    return createApiResponse(AssignableUserSchema.array().parse(users))
  })

  app.post('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(CreateTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await createHumanTask(prisma, {
      organizationId: actorContext.tenant.organizationId,
      createdByUserId: actorContext.actor.actorId,
      title: body.title,
      purpose: body.purpose,
      detail: body.detail,
      projectId: body.projectId,
      iterationId: body.iterationId,
      storyPoints: body.storyPoints,
      priority: body.priority,
      dueDate: body.dueDate,
      assigneeUserId: body.assigneeUserId,
      ownerUserId: body.ownerUserId,
    })

    if ('error' in result) {
      if (result.error === 'PROJECT_NOT_FOUND' || result.error === 'ITERATION_NOT_FOUND') {
        sendApiError(reply, 404, result.error, 'Project or iteration not found in this organization')
        return reply
      }
      sendApiError(reply, 400, result.error, 'Assignee or owner is not a member of this organization')
      return reply
    }

    return reply.code(201).send(createApiResponse(TaskRecordSchema.parse(result)))
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { taskId } = request.params as { taskId: string }
    const task = await getTask(prisma, taskId, actorContext.tenant.organizationId)
    if (!task) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(task))
  })

  app.post('/api/tasks/:taskId/assign', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(AssignTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await assignTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      assigneeUserId: body.assigneeUserId,
      actorId: actorContext.actor.actorId,
    })

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(reply, 400, result.error, 'Assignee is not a member of this organization')
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/move', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(MoveTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await moveTaskToColumn(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      columnId: body.columnId,
      actorId: actorContext.actor.actorId,
    })

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      if (result.error === 'COLUMN_NOT_FOUND') {
        sendApiError(reply, 404, 'COLUMN_NOT_FOUND', 'Column not found in this task\'s project')
        return reply
      }
      sendApiError(
        reply,
        409,
        result.error,
        `Cannot move task from ${result.from ?? 'unknown'} into that column`,
      )
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/iteration', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(SetTaskIterationBodySchema, request.body, reply)
    if (!body) return reply

    const result = await setTaskIteration(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      iterationId: body.iterationId,
    })
    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(reply, 404, result.error, 'Iteration not found in this task\'s project')
      return reply
    }
    return createApiResponse(TaskRecordSchema.parse(result))
  })

  app.patch('/api/tasks/:taskId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(UpdateTaskBodySchema, request.body, reply)
    if (!body) return reply
    const fields = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      ...(body.storyPoints !== undefined ? { storyPoints: body.storyPoints } : {}),
    }
    if (Object.keys(fields).length === 0) {
      sendApiError(reply, 400, 'NO_FIELDS', 'No updatable fields provided')
      return reply
    }

    const result = await updateTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      fields,
    })
    if ('error' in result) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return reply
    }
    return createApiResponse(TaskRecordSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/transition', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { taskId } = request.params as { taskId: string }
    const body = parseInput(TransitionTaskBodySchema, request.body, reply)
    if (!body) return reply

    const result = await transitionTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      status: body.status,
      actorId: actorContext.actor.actorId,
    })

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(
        reply,
        409,
        result.error,
        `Cannot transition task from ${result.from ?? 'unknown'} to ${body.status}`,
      )
      return reply
    }

    return createApiResponse(TaskRecordSchema.parse(result))
  })
}
