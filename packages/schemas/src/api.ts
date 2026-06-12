import { z } from 'zod'

import { NonEmptyStringSchema } from './schema-primitives.js'

export type ApiResponse<T> = {
  data: T
  meta?: PaginationMeta
}

export type ApiError = {
  error: {
    code: string
    message: string
    field?: string
    details?: unknown
  }
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    field: NonEmptyStringSchema.optional(),
    details: z.unknown().optional(),
  }),
})

export const PaginationDirectionSchema = z.enum(['forward', 'backward'])
export type PaginationDirection = z.infer<typeof PaginationDirectionSchema>

export const PaginationParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  direction: PaginationDirectionSchema.optional(),
})
export type PaginationParams = z.infer<typeof PaginationParamsSchema>

export const PaginationMetaSchema = z.object({
  cursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
  hasMore: z.boolean(),
})
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>

export const createApiResponseSchema = <TOutput>(
  dataSchema: z.ZodType<TOutput>,
) =>
  z.object({
    data: dataSchema,
    meta: PaginationMetaSchema.optional(),
  })
