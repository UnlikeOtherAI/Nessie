import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readAvatarUpload, sendAvatarRelayError } from './avatar-upload.js'
import { sendAvatarImage, sendAvatarNotFound } from './avatar-response.js'
import {
  deleteUoaWorkspaceAvatar,
  fetchUoaWorkspaceAvatar,
  putUoaWorkspaceAvatar,
  resolveUoaWorkspace,
  type UoaAvatarDeps,
  type UoaWorkspace,
} from '../services/uoa-avatar.js'
import {
  UoaRosterIdentityError,
  UoaRosterUnavailableError,
  withUoaRosterSubjectAssertion,
} from '../services/uoa-org-roster.js'
import type { RouteDeps } from './types.js'

/**
 * The workspace ("company") avatar UnlikeOtherAuthenticator holds for the
 * actor's team — read by everyone in the workspace, changed by owners/admins.
 * A separate read-only membership-scoped route serves the other teams visible
 * in the workspace picker.
 *
 * Every call is relayed as the signed-in person where that is possible: a
 * short-lived subject assertion of their UOA session puts the request on the
 * `/org/*` family, where UOA re-resolves their live membership and their
 * `teams.manage` capability, and where an organisation founded on another
 * UOA-integrated domain is reachable at all. `/domain/*` is the fallback for a
 * caller with no assertable UOA session, and for the picker's reads of a
 * workspace other than the one the session is standing in — UOA pins an
 * assertion to exactly the asserted workspace, so a foreign team id can never
 * ride one.
 *
 * `/domain/*` is full system trust for the domain: those mutations apply **no**
 * role check of their own, and UOA requires the calling product to gate first.
 * The owner/admin check below is therefore load-bearing on that path, and stays
 * the local entitlement gate on the `/org/*` path too. The current-workspace
 * mutation routes never take a team id from the request. The picker route
 * accepts a team id only for reads and verifies the signed-in user's membership
 * first.
 */

const NO_WORKSPACE_MESSAGE =
  'This workspace has no UnlikeOtherAI company avatar'

/**
 * Resolve the actor's UOA workspace, or answer 404. `actor.roles` is re-resolved
 * from the live organisation membership on every request (see
 * `lib/server-context.ts`), so it is safe to gate on here.
 */
const requireWorkspace = async (
  deps: RouteDeps,
  actorContext: AuthorizedActionContext,
  reply: FastifyReply,
): Promise<UoaWorkspace | null> => {
  const workspace = await resolveUoaWorkspace(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: actorContext.tenant.teamId ?? actorContext.actionContext.teamId,
  })
  if (!workspace) {
    sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
    return null
  }
  return workspace
}

/**
 * Relay credentials for one workspace: the caller's subject assertion when
 * their UOA session is for exactly this workspace, and nothing extra otherwise.
 *
 * `withUoaRosterSubjectAssertion` throws when the session does not match, which
 * here is not a refusal — it means only the `/domain/*` route is available, and
 * that route is legitimate (and is all a non-UOA deployment ever had).
 */
const relayCredentials = (
  actorContext: AuthorizedActionContext,
  workspace: UoaWorkspace,
  deps: UoaAvatarDeps,
): UoaAvatarDeps => {
  if (!workspace.externalOrgId) return deps
  try {
    return withUoaRosterSubjectAssertion(
      {
        externalOrgId: workspace.externalOrgId,
        externalTeamId: workspace.externalTeamId,
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

const requireWorkspaceAdmin = (
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
      'Only organisation owners and admins can change the workspace avatar',
    )
  }
  return allowed
}

const sendRelayError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean =>
  sendAvatarRelayError(request, reply, error, 'WORKSPACE_AVATAR_REJECTED')

const relayWorkspaceAvatar = async (
  request: FastifyRequest,
  reply: FastifyReply,
  workspace: UoaWorkspace,
  relayDeps: UoaAvatarDeps,
): Promise<FastifyReply> => {
  let image = null
  try {
    image = await fetchUoaWorkspaceAvatar(workspace, relayDeps)
  } catch (error) {
    if (sendRelayError(request, reply, error)) return reply
    throw error
  }

  if (!image) {
    return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
  }
  return sendAvatarImage(reply, image)
}

/**
 * `avatarDeps` is the injectable egress seam (pinned fetch + DNS) these relays
 * share. Production passes nothing.
 */
export const registerWorkspaceAvatarRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
  avatarDeps: UoaAvatarDeps = {},
): void => {
  const { requireActorContext } = deps

  app.get('/api/workspace/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const workspace = await requireWorkspace(deps, actorContext, reply)
    if (!workspace) return reply

    return relayWorkspaceAvatar(
      request,
      reply,
      workspace,
      relayCredentials(actorContext, workspace, avatarDeps),
    )
  })

  app.get<{ Params: { teamId: string } }>('/api/teams/:teamId/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (actorContext.actor.actorType !== 'user') {
      return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
    }

    const workspace = await resolveUoaWorkspace(deps.prisma, {
      teamId: request.params.teamId,
      userId: actorContext.actor.actorId,
    })
    if (!workspace) {
      return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
    }
    // The picker reads workspaces the session is not standing in, so an
    // assertion is only ever available for the active one. `relayCredentials`
    // supplies it there and falls back to `/domain/*` for the rest, which the
    // switcher already backstops with UOA's public team image.
    return relayWorkspaceAvatar(
      request,
      reply,
      workspace,
      relayCredentials(actorContext, workspace, avatarDeps),
    )
  })

  app.put('/api/workspace/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireWorkspaceAdmin(actorContext, reply)) return reply

    const workspace = await requireWorkspace(deps, actorContext, reply)
    if (!workspace) return reply

    const image = await readAvatarUpload(request, reply, 'workspace avatar')
    if (!image) return reply

    try {
      const written = await putUoaWorkspaceAvatar(
        workspace,
        image,
        relayCredentials(actorContext, workspace, avatarDeps),
      )
      if (!written) {
        return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
      }
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }

    return createApiResponse({ ok: true })
  })

  app.delete('/api/workspace/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireWorkspaceAdmin(actorContext, reply)) return reply

    const workspace = await requireWorkspace(deps, actorContext, reply)
    if (!workspace) return reply

    try {
      const cleared = await deleteUoaWorkspaceAvatar(
        workspace,
        relayCredentials(actorContext, workspace, avatarDeps),
      )
      if (!cleared) {
        return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
      }
    } catch (error) {
      if (sendRelayError(request, reply, error)) return reply
      throw error
    }

    return createApiResponse({ ok: true })
  })
}
