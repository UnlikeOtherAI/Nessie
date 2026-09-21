import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { attributionFromActorContext } from '@nessie/runtime'
import {
  CreateTaskCommentBodySchema,
  TaskCommentListSchema,
  TaskCommentRecordSchema,
  UpdateTaskCommentBodySchema,
} from '@nessie/schemas'
import { publishTaskActivity } from '@nessie/team-admin'

import { createApiResponse, parseInput } from '../lib/api.js'
import {
  createTaskComment,
  createTaskCommentWriteBack,
  deleteTaskComment,
  listTaskComments,
  updateTaskComment,
} from '../services/task-comments.js'
import { createTaskActivityGate, sendTaskActivityError } from './task-activity-gate.js'
import type { RouteDeps } from './types.js'

const ListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

/**
 * A ticket's comments. Reading and adding are anyone who can read the task;
 * editing and deleting are the author's alone — decided by the shared
 * functions, which the MCP tools and the worker's ticket tools call too.
 */
export const registerTaskCommentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub } = deps
  const gate = createTaskActivityGate(deps)

  const publish = (organizationId: string, taskId: string, projectId: string | null) =>
    publishTaskActivity(realtimeHub, { organizationId, taskId, projectId })

  app.get('/api/tasks/:taskId/comments', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const query = parseInput(ListQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await listTaskComments(prisma, access.actor, { taskId, ...query })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    return createApiResponse(TaskCommentListSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/comments', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const body = parseInput(CreateTaskCommentBodySchema, request.body, reply)
    if (!body) return reply
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await createTaskComment(prisma, access.actor, { taskId, ...body }, {
      writeBack: createTaskCommentWriteBack(prisma, deps.encryptionKeyRing),
    })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    await publish(access.actor.organizationId, taskId, result.projectId)
    return reply.code(201).send(createApiResponse(TaskCommentRecordSchema.parse(result.comment)))
  })

  app.patch('/api/tasks/:taskId/comments/:commentId', async (request, reply) => {
    const { taskId, commentId } = request.params as { taskId: string; commentId: string }
    const body = parseInput(UpdateTaskCommentBodySchema, request.body, reply)
    if (!body) return reply
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await updateTaskComment(prisma, access.actor, { taskId, commentId, body: body.body }, {
      writeBack: createTaskCommentWriteBack(prisma, deps.encryptionKeyRing),
    })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    await publish(access.actor.organizationId, taskId, result.projectId)
    return createApiResponse(TaskCommentRecordSchema.parse(result.comment))
  })

  app.delete('/api/tasks/:taskId/comments/:commentId', async (request, reply) => {
    const { taskId, commentId } = request.params as { taskId: string; commentId: string }
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await deleteTaskComment(prisma, access.actor, { taskId, commentId }, {
      fileService: deps.fileService,
      attribution: attributionFromActorContext(access.actorContext),
      writeBack: createTaskCommentWriteBack(prisma, deps.encryptionKeyRing),
    })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    await publish(access.actor.organizationId, taskId, result.projectId)
    return reply.code(204).send()
  })
}
