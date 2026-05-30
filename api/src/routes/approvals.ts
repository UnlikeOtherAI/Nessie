import type { FastifyInstance } from 'fastify'

import { parseAgentId, parseTaskId } from '@nessie/schemas'
import { createApiResponse, sendApiError } from '../lib/api.js'
import {
  getApprovalRequest,
  getPendingApprovalCount,
  listApprovalRequests,
  resolveApprovalRequest,
} from '../services/approvals.js'
import type { RouteDeps } from './types.js'

export const registerApprovalRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext } = deps

  app.get('/api/approvals', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const result = await listApprovalRequests(prisma, actorContext.tenant.organizationId, {
      status: query['status'],
      agentId: query['agentId'],
      channelId: query['channelId'],
      cursor: query['cursor'],
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: result.data, meta: result.meta }
  })

  app.get('/api/approvals/pending/count', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const count = await getPendingApprovalCount(prisma, actorContext.tenant.organizationId)
    return createApiResponse({ count })
  })

  app.get('/api/approvals/:approvalId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const approval = await getApprovalRequest(prisma, approvalId, actorContext.tenant.organizationId)
    if (!approval) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    return createApiResponse(approval)
  })

  app.post('/api/approvals/:approvalId/resolve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const body = request.body as { resolution: 'approved' | 'rejected'; note?: string }

    if (!body?.resolution || !['approved', 'rejected'].includes(body.resolution)) {
      sendApiError(reply, 400, 'INVALID_INPUT', 'resolution must be "approved" or "rejected"')
      return reply
    }

    const result = await resolveApprovalRequest(
      prisma,
      approvalId,
      actorContext,
      body.resolution,
      body.note,
    )

    if (!result) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    if ('error' in result && result.error) {
      const errorMap: Record<string, { code: number; message: string }> = {
        ALREADY_RESOLVED: { code: 409, message: 'Approval already resolved' },
        SELF_APPROVAL: { code: 403, message: 'Cannot approve your own request' },
        EXPIRED: { code: 410, message: 'Approval request has expired' },
        ROLE_REQUIRED: { code: 403, message: 'You do not have the required approver role' },
      }
      const err = errorMap[result.error] ?? { code: 400, message: 'Unknown error' }
      sendApiError(reply, err.code, result.error, err.message)
      return reply
    }

    // Publish WS event for approval resolution
    await realtimeHub.publishWs(
      [{ kind: 'organization', organizationId: actorContext.tenant.organizationId }],
      {
        data: {
          approvalId,
          taskId: parseTaskId(result.approval.taskId ?? '00000000-0000-4000-8000-000000000000'),
          agentId: parseAgentId(result.approval.agentId),
          outcome: body.resolution,
          resolverId: actorContext.actor.actorId,
          resolvedAt: new Date().toISOString(),
        },
        event: 'approval.resolved',
      },
    )

    return createApiResponse(result.approval)
  })
}
