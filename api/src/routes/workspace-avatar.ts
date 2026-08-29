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
  type UoaWorkspace,
} from '../services/uoa-avatar.js'
import type { RouteDeps } from './types.js'

/**
 * The workspace ("company") avatar UnlikeOtherAuthenticator holds for the
 * actor's team — read by everyone in the workspace, changed by owners/admins.
 * A separate read-only membership-scoped route serves the other teams visible
 * in the workspace picker.
 *
 * UOA's `/domain/teams/:teamId/avatar` endpoints take the domain-hash bearer
 * alone, which is full system trust for the domain and applies **no** role check
 * of its own. UOA requires the calling product to gate first, so the
 * owner/admin check below is the only thing standing between an ordinary member
 * and rewriting the whole workspace's picture. The current-workspace mutation
 * routes never take a team id from the request. The picker route accepts a team
 * id only for reads and verifies the signed-in user's membership first.
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
): Promise<FastifyReply> => {
  let image = null
  try {
    image = await fetchUoaWorkspaceAvatar(workspace.externalTeamId)
  } catch (error) {
    if (sendRelayError(request, reply, error)) return reply
    throw error
  }

  if (!image) {
    return sendAvatarNotFound(reply, NO_WORKSPACE_MESSAGE)
  }
  return sendAvatarImage(reply, image)
}

export const registerWorkspaceAvatarRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { requireActorContext } = deps

  app.get('/api/workspace/avatar', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply

    const workspace = await requireWorkspace(deps, actorContext, reply)
    if (!workspace) return reply

    return relayWorkspaceAvatar(request, reply, workspace)
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
    return relayWorkspaceAvatar(request, reply, workspace)
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
      const written = await putUoaWorkspaceAvatar(workspace.externalTeamId, image)
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
      const cleared = await deleteUoaWorkspaceAvatar(workspace.externalTeamId)
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
