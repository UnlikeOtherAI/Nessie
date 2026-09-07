import type { Prisma } from '@prisma/client'
import { buildAccessibleThreadWhere, type AgentVisibilityScope } from '@nessie/team-admin'

/**
 * Agent projections carry data learned in a conversation. A private or
 * protected source channel therefore needs the reader's live ChannelMember
 * row, even when this person is an organization owner or owns the agent.
 *
 * This is deliberately narrower than ordinary channel administration: only
 * disclosure-bearing agent reads turn off the owner-wide channel shortcut.
 */
export const buildDisclosureReadableThreadWhere = (
  visibility?: AgentVisibilityScope,
): Prisma.ThreadWhereInput =>
  visibility
    ? buildAccessibleThreadWhere({ ...visibility, includeAllOrgChannels: false })
    : {}

export const buildAccessibleRunWhere = (
  visibility?: AgentVisibilityScope,
): Prisma.RunWhereInput =>
  visibility ? { thread: buildDisclosureReadableThreadWhere(visibility) } : {}

export const toTimestamp = (value: Date | null | undefined): string | undefined =>
  value ? value.toISOString() : undefined
