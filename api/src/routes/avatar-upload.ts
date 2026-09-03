import type { FastifyReply, FastifyRequest } from 'fastify'

import { sendApiError } from '../lib/api.js'
import {
  ALLOWED_AVATAR_UPLOAD_TYPES,
  MAX_AVATAR_UPLOAD_BYTES,
  UoaAvatarRejectedError,
  UoaAvatarUnavailableError,
  type UoaAvatarUpload,
} from '../services/uoa-avatar.js'

/**
 * The shared half of the two UnlikeOtherAI avatar relays — the team
 * ("company") picture and a person's own profile picture. Both accept one
 * multipart image, enforce UOA's own ceiling before anything is buffered, and
 * map an upstream refusal onto the API's error envelope. The gate that decides
 * *whose* avatar may be written stays in each route; only the mechanics live
 * here.
 */

/** @fastify/multipart's over-the-limit signal from `toBuffer()`. */
const isFileTooLargeError = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'FST_REQ_FILE_TOO_LARGE'

/**
 * Read the single uploaded image, or answer the request and return null.
 * Bounded by the multipart limit, so this buffers at most 1 MiB — UOA's own
 * ceiling. Nothing is stored on the Nessie side.
 */
export const readAvatarUpload = async (
  request: FastifyRequest,
  reply: FastifyReply,
  subject: string,
): Promise<UoaAvatarUpload | null> => {
  const file = await request.file({ limits: { fileSize: MAX_AVATAR_UPLOAD_BYTES } })
  if (!file) {
    sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
    return null
  }

  const mime = (file.mimetype || '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!ALLOWED_AVATAR_UPLOAD_TYPES.has(mime)) {
    sendApiError(
      reply,
      415,
      'UNSUPPORTED_IMAGE_TYPE',
      `The ${subject} must be a PNG, JPEG or WebP image`,
    )
    return null
  }

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
      `The ${subject} must be under ${MAX_AVATAR_UPLOAD_BYTES} bytes`,
    )
    return null
  }
  if (body.byteLength === 0) {
    sendApiError(reply, 400, 'EMPTY_FILE', 'The uploaded image is empty')
    return null
  }

  return { body, contentType: mime, filename: file.filename || 'avatar' }
}

/** Map a relay failure onto the API's error envelope. Returns true if handled. */
export const sendAvatarRelayError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  rejectedCode: string,
): boolean => {
  if (error instanceof UoaAvatarRejectedError) {
    sendApiError(reply, error.statusCode, rejectedCode, error.message)
    return true
  }
  if (error instanceof UoaAvatarUnavailableError) {
    request.log.warn({ err: error }, 'uoa avatar relay failed')
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
