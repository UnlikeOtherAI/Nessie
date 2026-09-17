import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
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

    // Path and query params reach Prisma unvalidated in most route files
    // (`request.params as { … }` casts), so a caller-typed id lands on a
    // `@db.Uuid` column raw and Postgres rejects the cast: Prisma rethrows
    // that as P2023. That is a client typo, not a server fault — the same
    // trap `gmail-drafts.ts` used to guard per-route — so it answers 400.
    //
    // P2025 ("record not found": `update`/`delete`/`*OrThrow` on a missing
    // row) is the same class from the caller's side: the record they named
    // does not exist, which is what 404 means. Mapping it here could mask a
    // genuine server bug — an update aimed at a row the server itself should
    // have guaranteed would also read as 404. That is accepted deliberately:
    // routes whose missing row would be an internal inconsistency keep their
    // own domain mappers, which run first and never reach this backstop, and
    // a 404 for a stale caller-held id is correct far more often than a
    // server-computed id goes missing.
    //
    // Neither branch echoes `error.message`: Prisma interpolates the rejected
    // value and the model name into it — the same leak the 500 branch below
    // refuses. Fixed wording only, and no log line: a malformed id is a
    // client event, not an operator one.
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2023') {
        sendApiError(reply, 400, 'VALIDATION_ERROR', 'A request parameter was malformed')
        return
      }
      if (error.code === 'P2025') {
        sendApiError(reply, 404, 'NOT_FOUND', 'The requested record does not exist')
        return
      }
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
