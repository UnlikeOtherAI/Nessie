import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

import { sendApiError } from './api.js'

/**
 * Fastify's own errors (unsupported content-type, request/body too large, a
 * malformed JSON body caught by our content-type parser) carry a numeric
 * `statusCode` in the 4xx range and their own `code`. They are the caller's
 * mistake, so the message is safe to forward — unlike an unclassified 5xx,
 * where the underlying error can contain request data we must not echo back.
 */
const isClientFastifyError = (
  error: unknown,
): error is { statusCode: number; code?: string; message: string } =>
  typeof error === 'object'
  && error !== null
  && 'statusCode' in error
  && typeof (error as { statusCode: unknown }).statusCode === 'number'
  && (error as { statusCode: number }).statusCode >= 400
  && (error as { statusCode: number }).statusCode < 500

/**
 * Backstop behind the ~50 domain-specific `send*Error` mappers used across
 * routes (`agent-route-errors.ts`, `executor-route-errors.ts`, …): those
 * still run first and `return` before an error reaches here. This handler
 * only catches what nothing recognized — an unguarded `.parse()`, a rejected
 * promise, a genuine bug — and guarantees every response leaving the API
 * uses the one canonical `{ error: { code, message, field?, details? } }`
 * envelope from `sendApiError`, never Fastify's own default shape.
 */
export const registerApiErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      sendApiError(
        reply,
        400,
        'VALIDATION_ERROR',
        error.issues[0]?.message ?? 'Invalid request payload',
        undefined,
        error.flatten(),
      )
      return
    }

    if (isClientFastifyError(error)) {
      sendApiError(reply, error.statusCode, error.code ?? 'REQUEST_ERROR', error.message)
      return
    }

    // Never echo `error.message` here: it can contain interpolated request
    // data (a token, a body field) that a bare `throw new Error(...)` picked
    // up. The real error is still logged server-side for diagnosis.
    request.log.error({ err: error }, 'Unhandled error in request handler')
    sendApiError(reply, 500, 'INTERNAL_ERROR', 'An unexpected error occurred')
  })

  app.setNotFoundHandler((request, reply) => {
    sendApiError(
      reply,
      404,
      'NOT_FOUND',
      `Route ${request.method}:${request.url} not found`,
    )
  })
}
