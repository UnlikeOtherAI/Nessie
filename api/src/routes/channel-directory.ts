import type { FastifyInstance } from 'fastify'
import {
  ChannelDirectoryEntrySchema,
  ProjectDirectoryMemberSchema,
  isAdminActor,
} from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readChannelForViewer, readChannelRoster } from '../services/channel-directory.js'
import type { RouteDeps } from './types.js'

/**
 * Reading one channel, and its roster.
 *
 * These are the doorways a protected room is reached through. It is
 * deliberately absent from `GET /api/channels`, so without a direct read there
 * would be no way to open one at all — a lock nobody can knock on, which is the
 * unreachable capability Rule zero names.
 *
 * Both refuse with `404 CHANNEL_NOT_FOUND`, never `403`. A 403 confirms the
 * room exists, and for a direct message its very label discloses who is talking
 * to whom.
 *
 * They live in their own module because `routes/channels.ts` is at the file-size
 * cap, and because "what may somebody outside this room see of it" is a
 * different responsibility from the room's own lifecycle.
 */
export const registerChannelDirectoryRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireUserActor } = deps

  const CHANNEL_NOT_FOUND = 'Channel not found'

  app.get('/api/channels/:channelId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { channelId } = request.params as { channelId: string }
    const entry = await readChannelForViewer(
      prisma,
      {
        isOrganizationAdmin: isAdminActor(actorContext),
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
      channelId,
    )
    if (!entry) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', CHANNEL_NOT_FOUND)
      return reply
    }

    return createApiResponse(ChannelDirectoryEntrySchema.parse(entry))
  })

  /**
   * The channel's own roster.
   *
   * The members popup used to derive this from `GET /api/users`, which is why
   * an admin appeared to need the owner-shaped person list. That list is not
   * widened for them (`api/src/services/users.ts` explains what the full list
   * discloses); the room answers for itself instead.
   */
  app.get('/api/channels/:channelId/members', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply

    const { channelId } = request.params as { channelId: string }
    const members = await readChannelRoster(
      prisma,
      {
        isOrganizationAdmin: isAdminActor(actorContext),
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      },
      channelId,
    )
    if (!members) {
      sendApiError(reply, 404, 'CHANNEL_NOT_FOUND', CHANNEL_NOT_FOUND)
      return reply
    }

    return createApiResponse(ProjectDirectoryMemberSchema.array().parse(members))
  })
}
