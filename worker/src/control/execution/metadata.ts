import { type Prisma } from '@prisma/client'
import { asObject } from './stored-json.js'

export const mergeMetadata = (
  existing: unknown,
  patch: Record<string, unknown>,
): Prisma.InputJsonValue => ({
  ...asObject(existing),
  ...patch,
}) as Prisma.InputJsonValue
