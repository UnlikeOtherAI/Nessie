import type { Prisma } from '@prisma/client'

/**
 * Prisma's `InputJsonValue` is structurally incompatible with `unknown` (and
 * with most already-narrowed object/array types call sites hand it): the
 * generated type is a closed union of JSON primitives, plain objects and
 * arrays, and does not admit an arbitrary object or a value already typed as
 * something else without detouring through `unknown` first. Every write path
 * that hands Prisma a JSON column value hits the same wall, so this is the
 * one place that swallows it — a single, auditable escape hatch instead of a
 * `value as unknown as Prisma.InputJsonValue` repeated at every call site.
 */
export const toInputJson = (value: unknown): Prisma.InputJsonValue =>
  value as unknown as Prisma.InputJsonValue
