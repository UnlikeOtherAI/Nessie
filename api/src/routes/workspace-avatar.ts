import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { sendAvatarImage, sendAvatarNotFound } from './avatar-response.js'
import {
  ALLOWED_AVATAR_UPLOAD_TYPES,
  deleteUoaWorkspaceAvatar,
  fetchUoaWorkspaceAvatar,
  MAX_AVATAR_UPLOAD_BYTES,
  putUoaWorkspaceAvatar,
  resolveUoaWorkspace,
  UoaAvatarRejectedError,
  UoaAvatarUnavailableError,
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

// Mirrors the org logo route: owners and admins manage organisation identity.
const ADMIN_ROLES = new Set(['owner', 'admin'])

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
  const allowed = actorContext.actor.actorType === 'user'
    && (actorContext.actor.roles ?? []).some((role) => ADMIN_ROLES.has(role))
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

/** @fastify/multipart's over-the-limit signal from `toBuffer()`. */
const isFileTooLargeError = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'

/** Map a relay failure onto the API's error envelope. Returns true if handled. */
const sendRelayError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean => {
  if (error instanceof UoaAvatarRejectedError) {
    sendApiError(reply, error.statusCode, 'WORKSPACE_AVATAR_REJECTED', error.message)
    return true
  }
  if (error instanceof UoaAvatarUnavailableError) {
    request.log.warn({ err: error }, 'uoa workspace avatar relay failed')
    sendApiError(
      reply,
      502,
      'UOA_AVATAR_UNAVAILABLE',
      'The UnlikeOtherAI avatar service is temporarily unavailable',
    )
    return true
  }
  return false
}

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
      organizationId: actorContext.tenant.organizationId,
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

    const file = await request.file({ limits: { fileSize: MAX_AVATAR_UPLOAD_BYTES } })
    if (!file) {
      sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
      return reply
    }

    const mime = (file.mimetype || '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (!ALLOWED_AVATAR_UPLOAD_TYPES.has(mime)) {
      sendApiError(
        reply,
        415,
        'UNSUPPORTED_IMAGE_TYPE',
        'The workspace avatar must be a PNG, JPEG or WebP image',
      )
      return reply
    }

    // Bounded by the multipart limit above, so this buffers at most 1 MiB —
    // UOA's own ceiling. Nothing is stored on the Nessie side.
    let body: Buffer | null = null
    try {
      body = await file.toBuffer()
    } catch (error) {
      // Past the limit the plugin throws rather than returning a truncated
      // buffer; `truncated` covers the configurations where it does not.
      if (!isFileTooLargeError(error)) throw error
    }
    if (!body || file.file.truncated) {
      sendApiError(
        reply,
        413,
        'FILE_TOO_LARGE',
        `The workspace avatar must be under ${MAX_AVATAR_UPLOAD_BYTES} bytes`,
      )
      return reply
    }
    if (body.byteLength === 0) {
      sendApiError(reply, 400, 'EMPTY_FILE', 'The uploaded image is empty')
      return reply
    }

    try {
      const written = await putUoaWorkspaceAvatar(workspace.externalTeamId, {
        body,
        contentType: mime,
        filename: file.filename || 'avatar',
      })
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
