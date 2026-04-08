import type { ApiResponse, PaginationMeta } from '@nessie/schemas'
import type { FastifyReply } from 'fastify'
import type { ZodType } from 'zod'

export const createApiResponse = <T>(
  data: T,
  meta?: PaginationMeta,
): ApiResponse<T> => (meta ? { data, meta } : { data })

export const sendApiError = (
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  field?: string,
  details?: unknown,
) =>
  reply.code(statusCode).send({
    error: {
      code,
      message,
      field,
      details,
    },
  })

export const parseInput = <T>(
  schema: ZodType<T>,
  payload: unknown,
  reply: FastifyReply,
  field = 'body',
): T | null => {
  const parsed = schema.safeParse(payload)
  if (parsed.success) {
    return parsed.data
  }

  sendApiError(
    reply,
    400,
    'VALIDATION_ERROR',
    parsed.error.issues[0]?.message ?? 'Invalid request payload',
    field,
    parsed.error.flatten(),
  )

  return null
}
