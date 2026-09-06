import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

/**
 * Settings resolved across organisation → team → person, with locks.
 *
 * The rule is one sentence: walk from the organisation down, take the most
 * specific value, and stop at the first level marked `locked`. A lock is how
 * an ancestor says "this is the answer for everyone below" — and because the
 * level that locked it comes back with the answer, a surface can grey the
 * control out and say which level decided, instead of accepting an edit it
 * will silently discard.
 */

export const SETTING_SCOPES = ['organization', 'team', 'user'] as const

export type SettingScope = (typeof SETTING_SCOPES)[number]

/** Ordered outermost-first; resolution walks this array. */
const SCOPE_ORDER: readonly SettingScope[] = SETTING_SCOPES

export type ScopedSettingTarget = {
  organizationId: string
  /** The team in play, when there is one. Absent skips the team level. */
  teamId?: string | null
  /** The person in play, when there is one. Absent skips the user level. */
  userId?: string | null
}

export type ResolvedSetting<T = unknown> = {
  key: string
  /** The value in force, or null when no level has set one. */
  value: T | null
  /** Which level supplied that value; null when none did. */
  setAtScope: SettingScope | null
  /**
   * The level that forbade everything below it from overriding, or null when
   * nothing is locked. This is what a surface renders as "Disabled at the
   * organisation level".
   */
  lockedAtScope: SettingScope | null
}

type SettingRow = {
  scope: SettingScope
  value: Prisma.JsonValue | null
  locked: boolean
  /**
   * When this level was last written. Present on every row read from the
   * database; optional only so callers that hand-build rows (the pure-function
   * tests) need not invent a clock.
   */
  updatedAt?: Date | null
}

const scopeRank = (scope: SettingScope): number => SCOPE_ORDER.indexOf(scope)

/**
 * True when some level strictly above `scope` has locked the key, which is
 * exactly the condition under which that level's control must be read-only.
 * A level never locks itself out — locking is how you set a value *and* stop
 * others changing it.
 */
export const isLockedAbove = (
  resolved: Pick<ResolvedSetting, 'lockedAtScope'>,
  scope: SettingScope,
): boolean =>
  resolved.lockedAtScope !== null && scopeRank(resolved.lockedAtScope) < scopeRank(scope)

/**
 * Pure resolution, separated from IO so it is directly testable.
 *
 * The table's partial unique indexes mean two rows at one scope should not
 * exist. Should is not the same as cannot be handed to this function, which is
 * pure and takes whatever a caller passes — so it picks the newest `updatedAt`
 * rather than whichever row happened to arrive first, and a lock somebody just
 * set can never read back as absent.
 */
export const resolveFromRows = <T>(key: string, rows: readonly SettingRow[]): ResolvedSetting<T> => {
  const byScope = new Map<SettingScope, SettingRow>()
  for (const row of rows) {
    const held = byScope.get(row.scope)
    if (held && (held.updatedAt?.getTime() ?? 0) >= (row.updatedAt?.getTime() ?? 0)) continue
    byScope.set(row.scope, row)
  }

  let value: T | null = null
  let setAtScope: SettingScope | null = null

  for (const scope of SCOPE_ORDER) {
    const row = byScope.get(scope)
    if (!row) continue
    // A row with no value expresses only a lock: it pins whatever resolved
    // above it, which is how a setting whose value lives in its own table is
    // still governed by this one cascade.
    if (row.value !== null && row.value !== undefined) {
      value = row.value as T
      setAtScope = scope
    }
    if (row.locked) {
      return { key, lockedAtScope: scope, setAtScope, value }
    }
  }

  return { key, lockedAtScope: null, setAtScope, value }
}

const targetWhere = (target: ScopedSettingTarget): Prisma.ScopedSettingWhereInput[] => {
  const clauses: Prisma.ScopedSettingWhereInput[] = [{ scope: 'organization' }]
  if (target.teamId) clauses.push({ scope: 'team', teamId: target.teamId })
  if (target.userId) clauses.push({ scope: 'user', userId: target.userId })
  return clauses
}

type ScopedSettingReader = Pick<PrismaClient, 'scopedSetting'> | Prisma.TransactionClient

export const resolveScopedSettings = async <T = unknown>(
  prisma: ScopedSettingReader,
  target: ScopedSettingTarget,
  keys: readonly string[],
): Promise<Map<string, ResolvedSetting<T>>> => {
  const rows = keys.length === 0
    ? []
    : await prisma.scopedSetting.findMany({
      where: {
        organizationId: target.organizationId,
        key: { in: [...keys] },
        OR: targetWhere(target),
      },
      // Deterministic order, so the resolver never depends on heap order.
      // Belt and braces over the partial unique indexes: cheap on a query that
      // reads at most three rows, and the alternative is a resolution that is
      // only correct while nothing has ever gone wrong.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { key: true, scope: true, value: true, locked: true, updatedAt: true },
    })

  const grouped = new Map<string, SettingRow[]>()
  for (const row of rows) {
    const list = grouped.get(row.key) ?? []
    list.push({
      locked: row.locked,
      scope: row.scope as SettingScope,
      updatedAt: row.updatedAt,
      value: row.value,
    })
    grouped.set(row.key, list)
  }

  return new Map(
    keys.map((key) => [key, resolveFromRows<T>(key, grouped.get(key) ?? [])]),
  )
}

export const resolveScopedSetting = async <T = unknown>(
  prisma: ScopedSettingReader,
  target: ScopedSettingTarget,
  key: string,
): Promise<ResolvedSetting<T>> => {
  const resolved = await resolveScopedSettings<T>(prisma, target, [key])
  return resolved.get(key) ?? { key, lockedAtScope: null, setAtScope: null, value: null }
}

export type WriteScopedSettingInput = {
  organizationId: string
  scope: SettingScope
  teamId?: string | null
  userId?: string | null
  key: string
  /** null clears the value, leaving the row to express only its lock. */
  value: Prisma.InputJsonValue | null
  locked: boolean
  updatedByUserId: string
}

export const SCOPED_SETTING_ERROR_CODES = {
  LOCKED_ABOVE: 'SETTING_LOCKED_ABOVE',
  SCOPE_TARGET_MISMATCH: 'SETTING_SCOPE_TARGET_MISMATCH',
} as const

export class ScopedSettingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ScopedSettingError'
  }
}

const scopeLabel: Record<SettingScope, string> = {
  organization: 'organisation',
  team: 'team',
  user: 'personal',
}

/** The sentence a surface shows beside a control it has greyed out. */
export const lockExplanation = (lockedAtScope: SettingScope): string =>
  `This has been set at the ${scopeLabel[lockedAtScope]} level and cannot be changed here.`

/**
 * The advisory-lock name for one setting target.
 *
 * Assembled from exactly the columns the table's three partial unique indexes
 * cover, so two writers contend on the lock in precisely the cases one of them
 * would otherwise be rejected. `''` stands in for a null `teamId`/`userId`: the
 * scope is already part of the name, so an organisation row and a team row can
 * never collide on it.
 */
const settingLockName = (
  input: Pick<WriteScopedSettingInput, 'organizationId' | 'key' | 'scope'>,
  teamId: string | null,
  userId: string | null,
): string =>
  `scoped-setting:${input.organizationId}:${input.key}:${input.scope}:${teamId ?? ''}:${userId ?? ''}`

/**
 * Writes one level's row, refusing when a level above has locked the key.
 * Authorization for *this* level is the caller's — it mirrors the route the
 * person's button calls — but the lock is an invariant of the cascade itself
 * and is enforced here so no caller can forget it.
 *
 * Race-free across replicas: the transaction takes `pg_advisory_xact_lock` on
 * this exact target before it reads, so a second writer anywhere in the fleet
 * blocks until the first commits and then sees its row to update.
 *
 * What that fixes is NOT a duplicate row — the table's three partial unique
 * indexes (see `model ScopedSetting`) already make one impossible. It is that
 * find-then-create without a lock loses the race noisily: the second save of a
 * setting nobody had set yet found nothing, tried to create, and hit a unique
 * violation, so an ordinary "two people pressed Save" — or one person on a
 * fleet where a retry lands on another replica — surfaced as an opaque failure
 * instead of the update it should have been. The index is the guarantee; the
 * lock is what makes the write correct rather than merely safe.
 */
export const writeScopedSetting = async (
  prisma: PrismaClient,
  input: WriteScopedSettingInput,
): Promise<ResolvedSetting> => {
  const teamId = input.scope === 'team' ? input.teamId ?? null : null
  const userId = input.scope === 'user' ? input.userId ?? null : null
  if ((input.scope === 'team' && !teamId) || (input.scope === 'user' && !userId)) {
    throw new ScopedSettingError(
      SCOPED_SETTING_ERROR_CODES.SCOPE_TARGET_MISMATCH,
      'A team setting needs a team and a personal setting needs a person.',
    )
  }

  return prisma.$transaction(async (tx) => {
    // Before the read, not after: the whole point is that the loser of the race
    // waits here and then reads the winner's row.
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${settingLockName(input, teamId, userId)}::text, 0))
    `

    const current = await resolveScopedSetting(tx, {
      organizationId: input.organizationId,
      teamId,
      userId,
    }, input.key)

    if (isLockedAbove(current, input.scope)) {
      throw new ScopedSettingError(
        SCOPED_SETTING_ERROR_CODES.LOCKED_ABOVE,
        lockExplanation(current.lockedAtScope as SettingScope),
      )
    }

    const existing = await tx.scopedSetting.findFirst({
      where: {
        organizationId: input.organizationId,
        key: input.key,
        scope: input.scope,
        teamId,
        userId,
      },
      select: { id: true },
    })

    const data = {
      locked: input.locked,
      updatedByUserId: input.updatedByUserId,
      value: input.value === null ? Prisma.DbNull : input.value,
    }

    if (existing) {
      await tx.scopedSetting.update({ where: { id: existing.id }, data })
    } else {
      await tx.scopedSetting.create({
        data: {
          ...data,
          key: input.key,
          organizationId: input.organizationId,
          scope: input.scope,
          teamId,
          userId,
        },
      })
    }

    return resolveScopedSetting(tx, {
      organizationId: input.organizationId,
      teamId,
      userId,
    }, input.key)
  })
}
