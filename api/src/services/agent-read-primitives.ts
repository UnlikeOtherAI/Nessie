import type { Prisma } from '@prisma/client'
import { buildAccessibleThreadWhere, type AgentVisibilityScope } from '@nessie/team-admin'

export const buildAccessibleRunWhere = (
  visibility?: AgentVisibilityScope,
): Prisma.RunWhereInput =>
  visibility ? { thread: buildAccessibleThreadWhere(visibility) } : {}

export const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined
