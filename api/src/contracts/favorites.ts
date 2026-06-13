import { z } from 'zod'

import { TimestampSchema } from './shared.js'

export const FavoriteTargetTypeSchema = z.enum(['agent', 'channel', 'user'])
export type FavoriteTargetType = z.infer<typeof FavoriteTargetTypeSchema>

export const FavoriteRecordSchema = z.object({
  createdAt: TimestampSchema,
  targetId: z.string().uuid(),
  targetType: FavoriteTargetTypeSchema,
})
export type FavoriteRecord = z.infer<typeof FavoriteRecordSchema>

export const FavoriteTargetParamsSchema = z.object({
  targetId: z.string().uuid(),
  targetType: FavoriteTargetTypeSchema,
})
export type FavoriteTargetParams = z.infer<typeof FavoriteTargetParamsSchema>
