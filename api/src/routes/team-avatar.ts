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
  type UoaAvatarDeps,
  type UoaTeam,
} from '../services/uoa-avatar.js'
import {
  UoaRosterIdentityError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The team ("company") avatar UnlikeOtherAuthenticator holds for the
 * actor's team — read by everyone in the team, changed by owners/admins.
 * A separate read-only membership-scoped route serves the other teams visible
 * in the team picker.
 *
 * Every call is relayed as the signed-in person where that is possible: a
 * short-lived subject assertion of their UOA session puts the request on the
 * `/org/*` family, where UOA re-resolves their live membership and their
 * `teams.manage` capability, and where an organisation founded on another
 * UOA-integrated domain is reachable at all. `/domain/*` is the fallback for a
 * caller with no assertable UOA session. A session for the same organisation
 * may read another team shown in the picker: UOA re-resolves whether that
 * person may access the exact target team named by the route.
 *
 * `/domain/*` is full system trust for the domain: those mutations apply **no**
 * role check of their own, and UOA requires the calling product to gate first.
 * The owner/admin check below is therefore load-bearing on that path, and stays
 * the local entitlement gate on the `/org/*` path too. The current-team
 * mutation routes never take a team id from the request. The picker route
 * accepts a team id only for reads and verifies the signed-in user's membership
 * first.
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

/**
 * Relay credentials for one team: the caller's subject assertion when
 * their UOA session belongs to this organisation, and nothing extra otherwise.
 *
 * `withUoaRosterSubjectAssertion` throws when the session does not match, which
 * here is not a refusal — it means only the `/domain/*` route is available, and
 * that route is legitimate (and is all a non-UOA deployment ever had).
 */
const relayCredentials = (
  actorContext: AuthorizedActionContext,
  team: UoaTeam,
  deps: UoaAvatarDeps,
): UoaAvatarDeps => {
  // UOA pins an assertion to the session's active team. A picker row for a
  // different team must stay on the membership-scoped `/domain/*` read.
  if (
    !team.externalOrgId
    || actorContext.actionContext.uoaIdentity?.teamId !== team.externalTeamId
  ) return deps
  try {
    return withUoaRosterSubjectAssertion(
      {
        externalOrgId: team.externalOrgId,
        externalTeamId: team.externalTeamId,
      },
      actorContext.actionContext.uoaIdentity,
      deps,
    )
  } catch (error) {
    // No assertable session, or no signing material to assert with: either way
    // `/domain/*` is what is left, and it answers 404 if it cannot see the team.
    if (
      error instanceof UoaRosterIdentityError
      || error instanceof UoaRosterUnavailableError
    ) return deps
    throw error
  }
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
  relayDeps: UoaAvatarDeps,
): Promise<FastifyReply> => {
  let image = null
  try {
    image = await fetchUoaTeamAvatar(team, relayDeps)
  } catch (error) {
    if (sendRelayError(request, reply, error)) return reply
    throw error
  }

  if (!image) {
    return sendAvatarNotFound(reply, NO_TEAM_MESSAGE)
  }
  return sendAvatarImage(reply, image)
}

/**
 * `avatarDeps` is the injectable egress seam (pinned fetch + DNS) these relays
 * share. Production passes nothing.
 */
export const registerTeamAvatarRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  avatarDeps: UoaAvatarDeps = {},
): void => {
  const { requireActorContext } = deps

  app.get('/api/team/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const team = await requireTeam(deps, actorContext, reply)
    if (!team) return reply

    return relayTeamAvatar(
      request,
      reply,
      team,
      relayCredentials(actorContext, team, avatarDeps),
    )
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
    // The picker can read another team in the same UOA organisation.
    // `relayCredentials` asserts the person there; UOA authorizes the exact
    // target team rather than trusting the session's active-team accident.
    return relayTeamAvatar(
      request,
      reply,
      team,
      relayCredentials(actorContext, team, avatarDeps),
    )
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
      const written = await putUoaTeamAvatar(
        team,
        image,
        relayCredentials(actorContext, team, avatarDeps),
      )
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
      const cleared = await deleteUoaTeamAvatar(
        team,
        relayCredentials(actorContext, team, avatarDeps),
      )
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
