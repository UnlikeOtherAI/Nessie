import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readAvatarUpload, sendAvatarRelayError } from './avatar-upload.js'
import { sendAvatarImage, sendAvatarNotFound } from './avatar-response.js'
import {
  deleteUoaTeamAvatar,
  fetchUoaTeamAvatar,
  putUoaTeamAvatar,
  resolveUoaTeam,
  type UoaTeam,
} from '../services/uoa-avatar.js'
import type { RouteDeps } from './types.js'

/**
 * The team ("company") avatar UnlikeOtherAuthenticator holds for the
 * actor's team — read by everyone in the team, changed by owners/admins.
 * A separate read-only membership-scoped route serves the other teams visible
 * in the team picker.
 *
 * UOA's `/domain/teams/:teamId/avatar` endpoints take the domain-hash bearer
 * alone, which is full system trust for the domain and applies **no** role check
 * of its own. UOA requires the calling product to gate first, so the
 * owner/admin check below is the only thing standing between an ordinary member
 * and rewriting the whole team's picture. The current-team mutation
 * routes never take a team id from the request. The picker route accepts a team
 * id only for reads and verifies the signed-in user's membership first.
 */

const NO_TEAM_MESSAGE =
  'This team has no UnlikeOtherAI company avatar'

/**
 * Resolve the actor's UOA team, or answer 404. `actor.roles` is re-resolved
 * from the live organisation membership on every request (see
 * `lib/server-context.ts`), so it is safe to gate on here.
 */
const requireTeam = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): Promise<UoaTeam | null> => {
  const team = await resolveUoaTeam(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
  })
  if (!team) {
    sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
    return null
  }
  return team
}

const requireTeamAdmin = (
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): boolean => {
  // Mirrors the org logo route: owners and admins manage organisation identity.
  const allowed = actorContext.actor.actorType === 'user' && isAdminActor(actorContext)
  if (!allowed) {
    sendApiError(
      reply,
      403,
      'FORBIDDEN',
      'Only organisation owners and admins can change the team avatar',
    )
  }
  return allowed
}

const sendRelayError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean =>
  sendAvatarRelayError(request, reply, error, 'TEAM_AVATAR_REJECTED')

const relayTeamAvatar = async (
  request: FastifyRequest,
  reply: FastifyReply,
  team: UoaTeam,
): Promise<FastifyReply> => {
  let image = null
  try {
    image = await fetchUoaTeamAvatar(team.externalTeamId)
  } catch (error) {
    if (sendRelayError(request, reply, error)) return reply
    throw error
  }

  if (!image) {
    return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
  }
  return sendAvatarImage(reply, image)
}

export const registerTeamAvatarRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { requireActorContext } = deps

  app.get('/api/team/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const team = await requireTeam(deps, actorContext, reply)
    if (!team) return reply

    return relayTeamAvatar(request, reply, team)
  })

  app.get<{ Params: { teamId: string } }>('/api/teams/:teamId/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
    }

    const team = await resolveUoaTeam(deps.prisma, {
      teamId: request.params.teamId,
      userId: actorContext.actor.actorId,
    })
    if (!team) {
      return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
    }
    return relayTeamAvatar(request, reply, team)
  })

  app.put('/api/team/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireTeamAdmin(actorContext, reply)) return reply

    const team = await requireTeam(deps, actorContext, reply)
    if (!team) return reply

    const image = await readAvatarUpload(request, reply, 'team avatar')
    if (!image) return reply

    try {
      const written = await putUoaTeamAvatar(team.externalTeamId, image)
      if (!written) {
        return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
      }
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }

    return createApiResponse({ ok: true })
  })

  app.delete('/api/team/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireTeamAdmin(actorContext, reply)) return reply

    const team = await requireTeam(deps, actorContext, reply)
    if (!team) return reply

    try {
      const cleared = await deleteUoaTeamAvatar(team.externalTeamId)
      if (!cleared) {
        return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
      }
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }

    return createApiResponse({ ok: true })
  })
}
