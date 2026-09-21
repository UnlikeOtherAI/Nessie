import type { FastifyInstance } from 'fastify'

import {
  LinkTaskAttachmentsBodySchema,
  RemoveTaskAttachmentBodySchema,
  TaskAttachmentListSchema,
  TaskAttachmentRecordSchema,
} from '@nessie/schemas'
import { publishTaskActivity } from '@nessie/team-admin'

import { createApiResponse, parseInput } from '../lib/api.js'
import {
  linkTaskAttachments,
  listTaskAttachments,
  removeTaskAttachment,
} from '../services/task-attachments.js'
import { createTaskActivityGate, sendTaskActivityError } from './task-activity-gate.js'
import type { RouteDeps } from './types.js'

/**
 * A ticket's files. Bytes only ever arrive through `POST /api/uploads`; these
 * routes list, link and remove. Anyone who can see the ticket may remove a
 * file; removal is a mark (who, when, why) and the bytes stay downloadable,
 * so the answer is the updated record rather than a bare 204.
 */
export const registerTaskAttachmentRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub } = deps
  const gate = createTaskActivityGate(deps)

  app.get('/api/tasks/:taskId/attachments', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await listTaskAttachments(prisma, access.actor, { taskId })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    return createApiResponse(TaskAttachmentListSchema.parse(result))
  })

  app.post('/api/tasks/:taskId/attachments', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const body = parseInput(LinkTaskAttachmentsBodySchema, request.body, reply)
    if (!body) return reply
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await linkTaskAttachments(prisma, access.actor, { taskId, attachmentIds: body.attachmentIds })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    if (result.attachments.length > 0) {
      await publishTaskActivity(realtimeHub, {
        organizationId: access.actor.organizationId,
        taskId,
        projectId: result.projectId,
      })
    }
    return createApiResponse(TaskAttachmentListSchema.parse({ attachments: result.attachments }))
  })

  app.delete('/api/tasks/:taskId/attachments/:attachmentId', async (request, reply) => {
    const { taskId, attachmentId } = request.params as { taskId: string; attachmentId: string }
    // The body is optional: a bare DELETE (no content type) is a removal without a reason.
    const body = parseInput(RemoveTaskAttachmentBodySchema, request.body ?? {}, reply)
    if (!body) return reply
    const access = await gate(request, reply, taskId)
    if (!access) return reply
    const result = await removeTaskAttachment(prisma, access.actor, {
      taskId,
      attachmentId,
      reason: body.reason ?? null,
    })
    if ('error' in result) {
      sendTaskActivityError(reply, result)
      return reply
    }
    await publishTaskActivity(realtimeHub, {
      organizationId: access.actor.organizationId,
      taskId,
      projectId: result.projectId,
    })
    return createApiResponse(TaskAttachmentRecordSchema.parse(result.attachment))
  })
}
