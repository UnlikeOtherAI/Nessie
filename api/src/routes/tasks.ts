import type { FastifyInstance, FastifyReply } from 'fastify'

import { type AuthorizedActionContext, ProjectIdSchema, TaskStatusSchema } from '@nessie/schemas'
import {
  ArchiveDoneTasksBodySchema,
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
  archiveDoneTasks,
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


/**
 * A source refusal, in words that name the remedy. Synchronous by design: the
 * drag snaps back with the reason rather than a toast contradicting a board
 * the reader has already moved on from.
 */
const sendWriteBackError = (
  reply: Parameters<typeof sendApiError>[0],
  result: { error: string; detail?: string; code?: string },
): boolean => {
  switch (result.error) {
    case 'SOURCE_READ_ONLY':
      sendApiError(reply, 409, 'SOURCE_READ_ONLY', result.detail ?? 'That source is read only.')
      return true
    case 'SOURCE_REJECTED':
      sendApiError(
        reply,
        409,
        'SOURCE_REJECTED',
        result.detail ?? 'The provider refused that change.',
      )
      return true
    case 'ASSIGNEE_NOT_LINKED':
      sendApiError(
        reply,
        409,
        'ASSIGNEE_NOT_LINKED',
        result.detail ?? 'That assignee is not linked to a provider account.',
      )
      return true
    case 'SOURCE_UNAVAILABLE':
      sendApiError(
        reply,
        502,
        'SOURCE_UNAVAILABLE',
        result.detail ?? 'The provider could not be reached.',
      )
      return true
    default:
      return false
  }
}

export const registerTaskRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    listAccessibleProjectIds,
  } = deps

  const resolveTaskUserFilter = (
    value: string | undefined,
    actorContext: AuthorizedActionContext,
  ): string | undefined => {
    if (!value) return undefined
    return value === 'me' ? actorContext.actor.actorId : value
  }

  // Owners see every task in the org; everyone else is limited to their project
  // memberships (plus projectless and owned/assigned tasks).
  const taskVisibilityFor = async (actorContext: AuthorizedActionContext) => {
    const accessible = await listAccessibleProjectIds(actorContext)
    return accessible === 'all'
      ? undefined
      : { accessibleProjectIds: accessible, actorUserId: actorContext.actor.actorId }
  }

  const canAccessProject = async (
    actorContext: AuthorizedActionContext,
    projectId: string,
  ): Promise<boolean> => {
    const accessible = await listAccessibleProjectIds(actorContext)
    return accessible === 'all' || accessible.includes(projectId)
  }

  /**
   * Gate for every task mutation. Reads were gated but the mutation handlers
   * passed org scope only, so a non-member could both tamper with another
   * project's task and read it back out of the mutation response.
   */
  const requireTaskAccess = async (
    actorContext: AuthorizedActionContext,
    taskId: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const task = await getTask(
      prisma,
      taskId,
      actorContext.tenant.organizationId,
      await taskVisibilityFor(actorContext),
    )
    if (!task) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return false
    }
    return true
  }

  app.get('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const statusFilter = TaskStatusSchema.safeParse(query['status'])
    const projectFilter = ProjectIdSchema.safeParse(query['project'])
    const tasks = await listTasks(
      prisma,
      actorContext.tenant.organizationId,
      {
        assigneeUserId: resolveTaskUserFilter(query['assignee'], actorContext),
        ownerUserId: resolveTaskUserFilter(query['owner'], actorContext),
        status: statusFilter.success ? statusFilter.data : undefined,
        projectId: projectFilter.success ? projectFilter.data : undefined,
      },
      await taskVisibilityFor(actorContext),
    )
    return createApiResponse(TaskRecordSchema.array().parse(tasks))
  })

  app.get('/api/tasks/assignees', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const users = await listAssignableUsers(prisma, actorContext.tenant.organizationId)
    return createApiResponse(AssignableUserSchema.array().parse(users))
  })

  // Archive from the board's explicit, entitled project only.
  app.post('/api/tasks/archive-done', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(ArchiveDoneTasksBodySchema, request.body, reply)
    if (!body) return reply
    if (!(await canAccessProject(actorContext, body.projectId))) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const result = await archiveDoneTasks(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId: body.projectId,
      boardId: body.boardId,
      olderThanDays: body.olderThanDays,
    })
    if ('error' in result) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found in this project')
      return reply
    }
    return createApiResponse(result)
  })

  app.post('/api/tasks', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const body = parseInput(CreateTaskBodySchema, request.body, reply)
    if (!body) return reply
    // A project id is not an organisation-wide capability: creation is
    // limited to the caller's current project entitlement.
    if (body.projectId && !(await canAccessProject(actorContext, body.projectId))) {
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return reply
    }

    const result = await createHumanTask(prisma, {
      actorContext,
      organizationId: actorContext.tenant.organizationId,
      createdByUserId: actorContext.actor.actorId,
      title: body.title,
      purpose: body.purpose,
      detail: body.detail,
      projectId: body.projectId,
      boardId: body.boardId,
      iterationId: body.iterationId,
      storyPoints: body.storyPoints,
      priority: body.priority,
      dueDate: body.dueDate,
      assigneeUserId: body.assigneeUserId,
      assigneeAgentId: body.assigneeAgentId,
      ownerUserId: body.ownerUserId,
    })

    if ('error' in result) {
      if (
        result.error === 'PROJECT_NOT_FOUND' ||
        result.error === 'ITERATION_NOT_FOUND' ||
        result.error === 'BOARD_NOT_FOUND'
      ) {
        sendApiError(
          reply,
          404,
          result.error,
          'Project, board or iteration not found in this organization',
        )
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
    const task = await getTask(
      prisma,
      taskId,
      actorContext.tenant.organizationId,
      await taskVisibilityFor(actorContext),
    )
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
    if (!(await requireTaskAccess(actorContext, taskId, reply))) return reply

    const result = await assignTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      assigneeUserId: body.assigneeUserId,
      assigneeAgentId: body.assigneeAgentId,
      actorContext,
    }, deps.authSecret)

    if ('error' in result) {
      if (sendWriteBackError(reply, result)) return reply
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      sendApiError(reply, 400, result.error, 'Assignee is not a member or agent of this organization')
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
    if (!(await requireTaskAccess(actorContext, taskId, reply))) return reply

    const result = await moveTaskToColumn(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      columnId: body.columnId,
      actorId: actorContext.actor.actorId,
      position: body.position,
    }, deps.authSecret)

    if ('error' in result) {
      if (sendWriteBackError(reply, result)) return reply
      if (result.error === 'NOT_FOUND') {
        sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
        return reply
      }
      if (result.error === 'COLUMN_NOT_FOUND') {
        sendApiError(reply, 404, 'COLUMN_NOT_FOUND', 'Column not found in this task\'s project')
        return reply
      }
      // Every source refusal was answered above, so what is left is the
      // lifecycle one — and only that shape carries `from`.
      const from = 'from' in result ? result.from : undefined
      sendApiError(
        reply,
        409,
        result.error,
        `Cannot move task from ${from ?? 'unknown'} into that column`,
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
    if (!(await requireTaskAccess(actorContext, taskId, reply))) return reply

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
    if (!(await requireTaskAccess(actorContext, taskId, reply))) return reply
    const fields = {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
      ...(body.detail !== undefined ? { detail: body.detail } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      ...(body.archivedAt !== undefined ? { archivedAt: body.archivedAt } : {}),
      ...(body.storyPoints !== undefined ? { storyPoints: body.storyPoints } : {}),
      ...(body.fieldValues !== undefined ? { fieldValues: body.fieldValues } : {}),
    }
    if (Object.keys(fields).length === 0) {
      sendApiError(reply, 400, 'NO_FIELDS', 'No updatable fields provided')
      return reply
    }

    const result = await updateTask(prisma, {
      taskId,
      organizationId: actorContext.tenant.organizationId,
      fields,
    }, deps.authSecret)
    if ('error' in result) {
      if (sendWriteBackError(reply, result)) return reply
      // A refused custom field value says which field and why; anything else
      // about a task the caller could reach is a missing task.
      if (result.error === 'FIELD_UNKNOWN') {
        sendApiError(reply, 400, 'FIELD_UNKNOWN', 'That field is not defined on this project')
        return reply
      }
      if (result.error === 'FIELD_VALUE_INVALID') {
        sendApiError(reply, 400, 'FIELD_VALUE_INVALID', `Field value refused: ${result.reason}`)
        return reply
      }
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
    if (!(await requireTaskAccess(actorContext, taskId, reply))) return reply

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
