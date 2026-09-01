import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import {
  ALLOWED_GRANT_DURATIONS,
  allowedDurationsForBasis,
  canGrantDisclosure,
  expiryForDuration,
} from '../services/disclosure-grants.js'
import type { RouteDeps } from './types.js'

const GrantBodySchema = z.object({
  /** Share this one reply, or stand a rule up for the whole source scope. */
  kind: z.enum(['message', 'scope']),
  audienceKind: z.enum(['user', 'channel']).optional(),
  audienceId: z.string().uuid().optional(),
  duration: z.enum(ALLOWED_GRANT_DURATIONS).optional(),
})

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
    // Organisation scope alone is not enough to be *in the room*. Satisfying a
    // message's basis (a team scope, say) does not imply membership of the
    // channel it was posted in, so without this a member could share a reply out
    // of a channel they cannot see — and, with `audienceKind: 'channel'`,
    // publish it into one. Same visibility rule the thread read uses.
    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        thread: {
          channel: {
            organizationId: actorContext.tenant.organizationId,
            OR: [
              { visibility: 'public' },
              { members: { some: { userId: actorContext.actor.actorId } } },
            ],
          },
        },
      },
      select: {
        id: true,
        agentId: true,
        thread: { select: { channelId: true } },
        basisScopes: { select: { scopeType: true, scopeId: true } },
      },
    })
    if (!message) {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }
    if (message.basisScopes.length === 0) {
      sendApiError(
        reply,
        409,
        'DISCLOSURE_NOT_RESTRICTED',
        'This message is not restricted, so there is nothing to share.',
      )
      return reply
    }

    const entitled = await canGrantDisclosure(prisma, {
      basis: message.basisScopes,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!entitled) {
      sendApiError(
        reply,
        403,
        'DISCLOSURE_GRANT_NOT_ENTITLED',
        'You can only share content you can reach yourself.',
      )
      return reply
    }

    // The duration menu is capped by the most restrictive tier in the basis:
    // private material gets no standing option at all.
    const allowed = allowedDurationsForBasis(message.basisScopes)
    if (body.kind === 'scope' && !allowed.includes(body.duration ?? '10m')) {
      sendApiError(
        reply,
        422,
        'DISCLOSURE_DURATION_NOT_ALLOWED',
        'A standing rule is not available for this material.',
      )
      return reply
    }

    // Default to the shortest option: a share should expire unless the granter
    // deliberately chose otherwise.
    const duration = body.duration ?? '10m'
    const audienceKind = body.audienceKind ?? 'channel'
    const now = new Date()
    const expiresAt = expiryForDuration(duration, now)

    if (body.kind === 'message') {
      const audienceId = body.audienceId ?? message.thread.channelId
      // The audience was accepted as any uuid. A share is only as bounded as the
      // audience it names, so an unchecked one lets a granter widen a
      // restriction to a room they are not in, or to a stranger. Both are
      // resolved against the granter's own reach, never merely the organisation.
      const audienceExists = audienceKind === 'user'
        ? await prisma.organizationMember.findFirst({
          where: {
            deactivatedAt: null,
            organizationId: actorContext.tenant.organizationId,
            userId: audienceId,
          },
          select: { id: true },
        })
        : await prisma.channel.findFirst({
          where: {
            id: audienceId,
            organizationId: actorContext.tenant.organizationId,
            OR: [
              { visibility: 'public' },
              { members: { some: { userId: actorContext.actor.actorId } } },
            ],
          },
          select: { id: true },
        })
      if (!audienceExists) {
        sendApiError(
          reply,
          422,
          'DISCLOSURE_AUDIENCE_NOT_FOUND',
          audienceKind === 'user'
            ? 'That person is not an active member of this organisation.'
            : 'That channel does not exist, or you are not in it.',
        )
        return reply
      }

      const grant = await prisma.disclosureGrant.upsert({
        where: {
          messageId_audienceKind_audienceId: {
            messageId: message.id,
            audienceKind,
            audienceId,
          },
        },
        create: {
          audienceId,
          audienceKind,
          // A one-off share expires like a standing rule does. The scope branch
          // below always wrote this; the message branch computed `expiresAt` and
          // then dropped it, so every "share this once" was permanent — while
          // the card that sends it collects a duration and says otherwise.
          ...(expiresAt ? { expiresAt } : {}),
          grantedByUserId: actorContext.actor.actorId,
          messageId: message.id,
          organizationId: actorContext.tenant.organizationId,
        },
        update: {
          ...(expiresAt ? { expiresAt } : { expiresAt: null }),
          revokedAt: null,
        },
        select: { id: true },
      })
      return reply.code(201).send(createApiResponse({ id: grant.id, kind: 'message' }))
    }

    if (!message.agentId) {
      sendApiError(
        reply,
        409,
        'DISCLOSURE_SCOPE_GRANT_NEEDS_AGENT',
        'A standing rule applies to one agent, and this message has no agent author.',
      )
      return reply
    }

    // One row per (source scope, destination channel, agent). Non-widening is
    // structural: no wildcard, no inheritance, no fallback in the lookup.
    const created = await prisma.$transaction(
      message.basisScopes.map((scope) =>
        prisma.scopeDisclosureGrant.upsert({
          where: {
            sourceScopeType_sourceScopeId_destinationChannelId_agentId: {
              sourceScopeType: scope.scopeType,
              sourceScopeId: scope.scopeId,
              destinationChannelId: message.thread.channelId,
              agentId: message.agentId as string,
            },
          },
          create: {
            agentId: message.agentId as string,
            destinationChannelId: message.thread.channelId,
            ...(expiresAt ? { expiresAt } : {}),
            grantedByUserId: actorContext.actor.actorId,
            organizationId: actorContext.tenant.organizationId,
            sourceScopeId: scope.scopeId,
            sourceScopeType: scope.scopeType,
          },
          update: {
            ...(expiresAt ? { expiresAt } : { expiresAt: null }),
            revokedAt: null,
          },
          select: { id: true },
        })),
    )

    return reply
      .code(201)
      .send(createApiResponse({ ids: created.map((row: { id: string }) => row.id), kind: 'scope' }))
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
