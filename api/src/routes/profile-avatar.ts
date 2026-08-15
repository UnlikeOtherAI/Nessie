import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readAvatarUpload, sendAvatarRelayError } from './avatar-upload.js'
import {
  deleteUoaUserAvatar,
  putUoaUserAvatar,
  resolveOwnUoaSubject,
} from '../services/uoa-avatar.js'
import type { RouteDeps } from './types.js'

/**
 * A person's own profile picture, held by UnlikeOtherAI.
 *
 * UOA owns the profile of everyone who signs in through it, so a UOA session
 * changes its picture *there* — these routes stream the image straight to
 * `PUT/DELETE /domain/users/:uoaSub/avatar` and store nothing locally. The
 * local upload path (`PATCH /api/auth/me/avatar`, an `Attachment`) survives
 * only for deployments with no UOA and refuses a UOA session outright.
 *
 * The subject is always the acting user's own `User.uoaSub`, resolved
 * server-side. UOA's `/domain/*` mutations authenticate the *product* with the
 * domain-hash bearer and apply no per-person check of their own, so accepting a
 * subject from the request would let any signed-in user rewrite any picture in
 * the domain.
 *
 * Reads stay on the existing relay (`GET /api/users/:userId/avatar`), which
 * every avatar in the admin already resolves through.
 */

const NO_UOA_PROFILE_MESSAGE =
  'This account has no UnlikeOtherAI profile picture to change'

export const registerProfileAvatarRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext } = deps

  const requireOwnSubject = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return null
    if (actorContext.actor.actorType !== 'user') {
      sendApiError(reply, 404, 'UOA_PROFILE_NOT_LINKED', NO_UOA_PROFILE_MESSAGE)
      return null
    }
    const uoaSub = await resolveOwnUoaSubject(prisma, actorContext.actor.actorId)
    if (!uoaSub) {
      sendApiError(reply, 404, 'UOA_PROFILE_NOT_LINKED', NO_UOA_PROFILE_MESSAGE)
      return null
    }
    return uoaSub
  }

  app.put('/api/auth/me/avatar/uoa', async (request, reply) => {
    const uoaSub = await requireOwnSubject(request, reply)
    if (!uoaSub) return reply

    const image = await readAvatarUpload(request, reply, 'profile photo')
    if (!image) return reply

    try {
      const written = await putUoaUserAvatar(uoaSub, image)
      if (!written) {
        sendApiError(reply, 404, 'UOA_PROFILE_NOT_LINKED', NO_UOA_PROFILE_MESSAGE)
        return reply
      }
    } catch (error) {
      if (sendAvatarRelayError(request, reply, error, 'PROFILE_AVATAR_REJECTED')) {
        return reply
      }
      throw error
    }

    return createApiResponse({ ok: true })
  })

  app.delete('/api/auth/me/avatar/uoa', async (request, reply) => {
    const uoaSub = await requireOwnSubject(request, reply)
    if (!uoaSub) return reply

    try {
      const cleared = await deleteUoaUserAvatar(uoaSub)
      if (!cleared) {
        sendApiError(reply, 404, 'UOA_PROFILE_NOT_LINKED', NO_UOA_PROFILE_MESSAGE)
        return reply
      }
    } catch (error) {
      if (sendAvatarRelayError(request, reply, error, 'PROFILE_AVATAR_REJECTED')) {
        return reply
      }
      throw error
    }

    return createApiResponse({ ok: true })
  })
}
