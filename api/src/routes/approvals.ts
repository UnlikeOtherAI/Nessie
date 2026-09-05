import type { FastifyInstance } from 'fastify'

import { parseAgentId, parseChannelId, parseTaskId } from '@nessie/schemas'
import { ApprovalRequestRecordSchema, ResolveApprovalBodySchema } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  getApprovalRequest,
  getPendingApprovalCount,
  listApprovalRequests,
  resolveApprovalRequest,
} from '../services/approvals.js'
import type { RouteDeps } from './types.js'

/**
 * Keyed by the service's own error union (`Extract<...>['error']`) rather
 * than a hand-copied list of strings: a new refusal `resolveApprovalRequest`
 * returns and this map does not cover is a compile error, not a silent
 * "Unknown error" 400 at runtime (see FO1-11).
 */
type ApprovalResolveErrorCode = Extract<
  Awaited<ReturnType<typeof resolveApprovalRequest>>,
  { error: string }
>['error']

const APPROVAL_RESOLVE_ERROR_MAP: Record<ApprovalResolveErrorCode, { code: number; message: string }> = {
  ALREADY_RESOLVED: { code: 409, message: 'Approval already resolved' },
  SELF_APPROVAL: { code: 403, message: 'Cannot approve your own request' },
  // The strongest refusal on this surface: an approval pinned to a specific
  // person cannot be resolved by anyone else, even another owner — a 403,
  // not the generic 400 it used to fall through to.
  APPROVER_REQUIRED: { code: 403, message: 'Only the named approver may resolve this request' },
  EXPIRED: { code: 410, message: 'Approval request has expired' },
  ROLE_REQUIRED: { code: 403, message: 'You do not have the required approver role' },
  RUN_NOT_WAITING: { code: 409, message: 'Approval is not ready to resolve' },
}

export const registerApprovalRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, realtimeHub, requireActorContext } = deps

  app.get('/api/approvals', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const query = request.query as Record<string, string | undefined>
    const result = await listApprovalRequests(prisma, actorContext, {
      status: query['status'],
      agentId: query['agentId'],
      channelId: query['channelId'],
      cursor: query['cursor'],
      direction: query['direction'] === 'backward' ? 'backward' : 'forward',
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
    })

    return { data: ApprovalRequestRecordSchema.array().parse(result.data), meta: result.meta }
  })

  app.get('/api/approvals/pending/count', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const count = await getPendingApprovalCount(prisma, actorContext)
    return createApiResponse({ count })
  })

  app.get('/api/approvals/:approvalId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const approval = await getApprovalRequest(prisma, approvalId, actorContext)
    if (!approval) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Approval request not found')
      return reply
    }

    return createApiResponse(ApprovalRequestRecordSchema.parse(approval))
  })

  app.post('/api/approvals/:approvalId/resolve', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const { approvalId } = request.params as { approvalId: string }
    const body = parseInput(ResolveApprovalBodySchema, request.body, reply)
    if (!body) return reply

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
      const err = APPROVAL_RESOLVE_ERROR_MAP[result.error]
      sendApiError(reply, err.code, result.error, err.message)
      return reply
    }

    // Publish WS event for approval resolution
    await realtimeHub.publishWs(
      [
        { kind: 'organization', organizationId: actorContext.tenant.organizationId },
        ...(result.approval.channelId
          ? [{ kind: 'channel' as const, channelId: parseChannelId(result.approval.channelId) }]
          : []),
      ],
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

    return createApiResponse(ApprovalRequestRecordSchema.parse(result.approval))
  })
}
