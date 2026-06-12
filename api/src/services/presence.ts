import type { PrismaClient, UserPresenceManualState } from '@prisma/client'

import { resolveActiveStatus, type StatusWithRelations } from './user-statuses.js'

const DEFAULT_ACTIVE_WITHIN_MS = 30_000

// A presence row is considered live while its `lastSeenAt` heartbeat is recent.
// Clients heartbeat every ~25s, so two missed beats fall through to offline.
const OFFLINE_AFTER_MS = 70_000

// No genuine user activity (input / foreground) within this window flips an
// otherwise-connected user to "away".
const AWAY_AFTER_MS = 5 * 60_000

export type PresenceState = 'online' | 'away' | 'offline'

// One user's live state for the org presence map. `statusEmoji`/`statusLabel`
// surface the user's active custom status so avatars can badge it everywhere.
export type OrgPresenceEntry = {
  userId: string
  state: PresenceState
  manualState: UserPresenceManualState | null
  statusId: string | null
  statusEmoji: string | null
  statusLabel: string | null
}

type PresencePrisma = Pick<PrismaClient, 'userPresence'>

export const markConnected = async (
  prisma: PresencePrisma,
  userId: string,
  organizationId: string,
): Promise<void> => {
  const now = new Date()
  await prisma.userPresence.upsert({
    where: { userId },
    create: {
      userId,
      organizationId,
      connections: 1,
      lastSeenAt: now,
    },
    update: {
      organizationId,
      connections: { increment: 1 },
      lastSeenAt: now,
    },
  })
}

export const markDisconnected = async (
  prisma: PresencePrisma,
  userId: string,
): Promise<void> => {
  await prisma.userPresence.updateMany({
    where: {
      userId,
      connections: { gt: 0 },
    },
    data: {
      connections: { decrement: 1 },
    },
  })
}

export const touch = async (
  prisma: PresencePrisma,
  userId: string,
): Promise<void> => {
  await prisma.userPresence.updateMany({
    where: { userId },
    data: { lastSeenAt: new Date() },
  })
}

export const isUserActive = async (
  prisma: PresencePrisma,
  userId: string,
  withinMs = DEFAULT_ACTIVE_WITHIN_MS,
): Promise<boolean> => {
  const activePresence = await prisma.userPresence.findFirst({
    where: {
      userId,
      connections: { gt: 0 },
      lastSeenAt: { gte: new Date(Date.now() - withinMs) },
    },
    select: { userId: true },
  })

  return activePresence !== null
}

// Periodic client heartbeat: `lastSeenAt` always refreshes (liveness, drives
// online/offline), `lastActiveAt` only when the client reports genuine activity
// (drives online/away). Independent of the SSE stream so presence works even
// with notifications disabled.
export const recordHeartbeat = async (
  prisma: PresencePrisma,
  userId: string,
  organizationId: string,
  active: boolean,
): Promise<void> => {
  const now = new Date()
  await prisma.userPresence.upsert({
    where: { userId },
    create: {
      userId,
      organizationId,
      connections: 0,
      lastSeenAt: now,
      lastActiveAt: active ? now : null,
    },
    update: {
      organizationId,
      lastSeenAt: now,
      ...(active ? { lastActiveAt: now } : {}),
    },
  })
}

// Manual override: `active`/`away` force the state regardless of detected
// activity (offline still wins when the heartbeat goes stale); `null` reverts
// to automatic detection.
export const setManualState = async (
  prisma: PresencePrisma,
  userId: string,
  organizationId: string,
  state: UserPresenceManualState | null,
): Promise<void> => {
  const now = new Date()
  await prisma.userPresence.upsert({
    where: { userId },
    create: {
      userId,
      organizationId,
      connections: 0,
      lastSeenAt: now,
      lastActiveAt: now,
      manualState: state,
    },
    update: {
      organizationId,
      lastSeenAt: now,
      manualState: state,
    },
  })
}

type PresenceRowLike = {
  lastSeenAt: Date
  lastActiveAt: Date | null
  manualState: UserPresenceManualState | null
}

// Pure state resolution: offline if the heartbeat is stale; else a manual
// override wins; else automatic online/away from `lastActiveAt`.
export const resolvePresenceState = (
  row: PresenceRowLike,
  now = Date.now(),
): PresenceState => {
  if (now - row.lastSeenAt.getTime() > OFFLINE_AFTER_MS) {
    return 'offline'
  }
  if (row.manualState === 'away') {
    return 'away'
  }
  if (row.manualState === 'active') {
    return 'online'
  }
  if (row.lastActiveAt && now - row.lastActiveAt.getTime() <= AWAY_AFTER_MS) {
    return 'online'
  }
  return 'away'
}

const buildEntry = (
  userId: string,
  row: PresenceRowLike | null,
  status: ReturnType<typeof resolveActiveStatus>,
  now = Date.now(),
): OrgPresenceEntry => ({
  userId,
  state: row ? resolvePresenceState(row, now) : 'offline',
  manualState: row?.manualState ?? null,
  statusId: status?.id ?? null,
  statusEmoji: status?.emoji ?? null,
  statusLabel: status?.label ?? null,
})

// Live state + active custom status for every user in the org who is either
// currently present or advertising a status. Users absent from the result are
// implicitly offline with no status.
export const listOrganizationPresence = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<OrgPresenceEntry[]> => {
  const now = Date.now()
  const [rows, statuses] = await Promise.all([
    prisma.userPresence.findMany({ where: { organizationId } }),
    prisma.userStatus.findMany({
      where: {
        organizationId,
        OR: [{ isActive: true }, { schedules: { some: { enabled: true } } }],
      },
      include: { schedules: true, rules: true },
    }),
  ])

  const statusesByUser = new Map<string, StatusWithRelations[]>()
  for (const status of statuses) {
    const list = statusesByUser.get(status.userId) ?? []
    list.push(status)
    statusesByUser.set(status.userId, list)
  }

  const activeStatusByUser = new Map<string, ReturnType<typeof resolveActiveStatus>>()
  for (const [uid, list] of statusesByUser) {
    const active = resolveActiveStatus(list, new Date(now))
    if (active) {
      activeStatusByUser.set(uid, active)
    }
  }

  const rowByUser = new Map(rows.map((row) => [row.userId, row]))
  const userIds = new Set<string>([...rowByUser.keys(), ...activeStatusByUser.keys()])

  return [...userIds].map((uid) =>
    buildEntry(uid, rowByUser.get(uid) ?? null, activeStatusByUser.get(uid) ?? null, now),
  )
}

// A single user's entry (used to echo the caller's state after a change).
export const getPresenceEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<OrgPresenceEntry> => {
  const [row, statuses] = await Promise.all([
    prisma.userPresence.findUnique({ where: { userId } }),
    prisma.userStatus.findMany({
      where: { organizationId, userId },
      include: { schedules: true, rules: true },
    }),
  ])
  return buildEntry(userId, row, resolveActiveStatus(statuses), Date.now())
}
