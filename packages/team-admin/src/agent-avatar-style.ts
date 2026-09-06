import type { PrismaClient } from '@prisma/client'
import {
  lockExplanation,
  resolveScopedSetting,
  SCOPED_SETTING_ERROR_CODES,
  ScopedSettingError,
  writeScopedSetting,
  type SettingScope,
} from '@nessie/runtime'
import {
  AGENT_AVATAR_STYLE_SETTING_KEY,
  AgentAvatarStyleSchema,
  parseStoredAgentAvatarStyle,
} from '@nessie/schemas'

/**
 * The remembered look for generated agent portraits, read and written through
 * the one settings cascade.
 *
 * Shared here rather than in either process because both faces need it: the
 * worker resolves it when the Agent Designer creates or restyles an agent, and
 * `POST /api/agents` resolves it so an agent created from the form gets the
 * same person's style without their having to say it twice. A second copy
 * would be two answers to "what does this person's portrait look like".
 *
 * The rule the cascade already states applies unchanged: an organisation may
 * set a house style and lock it, in which case `writeAgentAvatarStyle` refuses
 * exactly as the settings route does, and the resolver says which level
 * decided.
 */

export type AgentAvatarStyleTarget = {
  organizationId: string
  /** The team in play, when the caller knows one. Absent skips that level. */
  teamId?: string | null
  userId: string
}

export type ResolvedAgentAvatarStyle = {
  /** The style in force, or null when nobody has chosen one. */
  style: string | null
  /**
   * The level that pinned it against everything below, or null. A person's own
   * choice cannot win under an `organization` or `team` lock.
   */
  lockedAtScope: SettingScope | null
}

type ScopedSettingReader = Pick<PrismaClient, 'scopedSetting'>

export const resolveAgentAvatarStyle = async (
  prisma: ScopedSettingReader,
  target: AgentAvatarStyleTarget,
): Promise<ResolvedAgentAvatarStyle> => {
  const resolved = await resolveScopedSetting(
    prisma,
    {
      organizationId: target.organizationId,
      teamId: target.teamId ?? null,
      userId: target.userId,
    },
    AGENT_AVATAR_STYLE_SETTING_KEY,
  )
  return {
    lockedAtScope: resolved.lockedAtScope,
    style: parseStoredAgentAvatarStyle(resolved.value),
  }
}

/**
 * Which style this generation actually draws in.
 *
 * A lock above the person decides the picture, not merely whether their
 * preference may be stored. Enforcing it on the write alone would draw the
 * billed portrait in the style they asked for and then refuse to remember it —
 * the house style pinned in name only, and the two faces disagreeing, because
 * the form path resolves the style server-side and cannot be told otherwise.
 */
export const styleForGeneration = (
  remembered: ResolvedAgentAvatarStyle,
  requested?: string | null,
): { pinned: boolean; style: string | null } => {
  const pinned = remembered.lockedAtScope !== null && remembered.lockedAtScope !== 'user'
  return {
    pinned,
    style: pinned ? remembered.style : requested ?? remembered.style,
  }
}

/**
 * A style resolved for one generation, or null when a portrait should follow
 * the default look. Never throws: a portrait is not worth failing an agent
 * creation for, and neither is reading the taste behind it.
 */
export const resolveAgentAvatarStyleSafely = async (
  prisma: ScopedSettingReader,
  target: AgentAvatarStyleTarget,
): Promise<string | null> => {
  try {
    return (await resolveAgentAvatarStyle(prisma, target)).style
  } catch {
    return null
  }
}

/**
 * Remember this person's style. Mirrors `PUT /api/settings` at the personal
 * scope — a person's own setting is theirs to write — and inherits that
 * route's refusal when a level above has locked the key.
 */
export const writeAgentAvatarStyle = async (
  prisma: PrismaClient,
  target: AgentAvatarStyleTarget & { style: string },
): Promise<string> => {
  const style = AgentAvatarStyleSchema.parse(target.style)
  // The team level of a personal cascade, checked here for the same reason the
  // route checks it: `writeScopedSetting` is given no team on a personal write
  // (a person may be in several), so a team lock would otherwise be invisible
  // to it. The caller's team is the run's own tenant team, already verified.
  const current = await resolveAgentAvatarStyle(prisma, target)
  if (current.lockedAtScope !== null && current.lockedAtScope !== 'user') {
    throw new ScopedSettingError(
      SCOPED_SETTING_ERROR_CODES.LOCKED_ABOVE,
      lockExplanation(current.lockedAtScope),
    )
  }
  await writeScopedSetting(prisma, {
    key: AGENT_AVATAR_STYLE_SETTING_KEY,
    locked: false,
    organizationId: target.organizationId,
    scope: 'user',
    updatedByUserId: target.userId,
    userId: target.userId,
    value: style,
  })
  return style
}
