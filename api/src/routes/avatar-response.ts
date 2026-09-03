import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'
import type { UoaAvatarImage } from '../services/uoa-avatar.js'

/**
 * Shared HTTP shape for the UOA avatar relays (`routes/users.ts`,
 * `routes/team-avatar.ts`). Both stream third-party image bytes from the
 * same upstream under the same rules, so the headers are defined once.
 */

// Avatars are re-rendered on every mount of every surface, so both the hit and
// the miss must be cacheable — otherwise a deployment without UOA (or with
// mostly unlinked subjects) re-asks the API for each one, forever.
export const AVATAR_CACHE_CONTROL = 'private, max-age=300'

/** Relay image bytes with the download hardening the browser needs. */
export const sendAvatarImage = (
  reply: FastifyReply,
  image: UoaAvatarImage,
): FastifyReply => {
  reply.header(
    'content-type',
    image.contentType === 'image/svg+xml'
      ? 'image/svg+xml; charset=utf-8'
      : image.contentType,
  )
  reply.header('content-length', image.body.byteLength.toString())
  reply.header('cache-control', AVATAR_CACHE_CONTROL)
  reply.header('x-content-type-options', 'nosniff')
  // Generated avatars are SVG documents; deny them every external reference and
  // script origin even though they are only ever rendered in an <img>.
  reply.header('content-security-policy', "default-src 'none'")
  if (image.source) {
    reply.header('x-uoa-avatar-source', image.source)
  }
  return reply.send(image.body)
}

/**
 * "There is no UOA avatar here" — an unlinked user, a team that was never bound
 * to a UOA team, or a deployment with no UOA at all. Cacheable, because the
 * client asks again on every mount and the answer will not change soon.
 */
export const sendAvatarNotFound = (
  reply: FastifyReply,
  message: string,
): FastifyReply => {
  reply.header('cache-control', AVATAR_CACHE_CONTROL)
  sendApiError(reply, 404, 'AVATAR_NOT_FOUND', message)
  return reply
}
