import type { Prisma } from '@prisma/client'

export const parseOptional = <T>(
  value: string | null | undefined,
  parser: (value: string) => T,
): T | undefined => (value ? parser(value) : undefined)

export const toJsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const toInputJsonObject = (
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonObject | undefined =>
  value ? (value as Prisma.InputJsonObject) : undefined

export const toInputJsonObjectWithDefault = (
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonObject => (value ?? {}) as Prisma.InputJsonObject
