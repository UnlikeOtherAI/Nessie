import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  ALLOWED_GRANT_DURATIONS,
  DisclosureGrantError,
  grantMessageDisclosure,
  grantScopeDisclosure,
} from '../services/disclosure-grants.js'
import type { RouteDeps } from './types.js'

const GrantBodySchema = z.object({
  /** Share this one reply, or stand a rule up for the whole source scope. */
  kind: z.enum(['message', 'scope']),
  audienceKind: z.enum(['user', 'channel']).optional(),
  audienceId: z.string().uuid().optional(),
  duration: z.enum(ALLOWED_GRANT_DURATIONS).optional(),
})

const sendDisclosureGrantError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof DisclosureGrantError)) return false
  sendApiError(reply, error.status, error.code, error.message)
  return true
}

export const registerDisclosureGrantRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  /**
   * Answer the acknowledgement card.
   *
   * Human sessions only — an agent must never be able to lift a restriction it
   * is subject to, and there is deliberately no agent-reachable path here. The
   * caller must currently satisfy the message's full basis, verified against
   * live membership inside the same transaction as the insert.
   */
  app.post('/api/messages/:messageId/disclosure-grants', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(
        reply,
        403,
        'DISCLOSURE_GRANT_REQUIRES_HUMAN',
        'Only a person can share restricted content.',
      )
      return reply
    }

    const body = parseInput(GrantBodySchema, request.body ?? {}, reply)
    if (!body) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }

    try {
      if (body.kind === 'message') {
        const grant = await grantMessageDisclosure(prisma, {
          organizationId: actorContext.tenant.organizationId,
          userId: actorContext.actor.actorId,
          messageId,
          ...(body.audienceKind !== undefined ? { audienceKind: body.audienceKind } : {}),
          ...(body.audienceId !== undefined ? { audienceId: body.audienceId } : {}),
          ...(body.duration !== undefined ? { duration: body.duration } : {}),
        })
        return reply.code(201).send(createApiResponse({ id: grant.id, kind: 'message' }))
      }

      const grant = await grantScopeDisclosure(prisma, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
        messageId,
        ...(body.duration !== undefined ? { duration: body.duration } : {}),
      })
      return reply.code(201).send(createApiResponse({ ids: grant.ids, kind: 'scope' }))
    } catch (error) {
      if (sendDisclosureGrantError(reply, error)) return reply
      throw error
    }
  })

  /** Withdraw a grant. Immediate everywhere, because evaluation is read-time. */
  app.delete('/api/disclosure-grants/:grantId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 403, 'DISCLOSURE_GRANT_REQUIRES_HUMAN', 'Only a person can revoke a share.')
      return reply
    }

    const { grantId } = request.params as { grantId: string }
    const now = new Date()
    const [messageGrants, scopeGrants] = await Promise.all([
      // Your share, your revoke. The filter was organisation-wide, which was
      // only ever safe because grant ids are not listed anywhere — an audit
      // export or a future listing endpoint would have made it a real
      // cross-user write. Ownership is the property that should hold regardless.
      prisma.disclosureGrant.updateMany({
        where: {
          id: grantId,
          grantedByUserId: actorContext.actor.actorId,
          organizationId: actorContext.tenant.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      }),
      prisma.scopeDisclosureGrant.updateMany({
        where: {
          id: grantId,
          grantedByUserId: actorContext.actor.actorId,
          organizationId: actorContext.tenant.organizationId,
          revokedAt: null,
        },
        data: { revokedAt: now },
      }),
    ])

    if (messageGrants.count + scopeGrants.count === 0) {
      sendApiError(reply, 404, 'DISCLOSURE_GRANT_NOT_FOUND', 'Grant not found')
      return reply
    }
    return createApiResponse({ revoked: true })
  })
}
