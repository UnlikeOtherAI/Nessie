import type { PrismaClient } from '@prisma/client'
import type { BoardSourceHealth } from '@nessie/schemas'

/**
 * A board source that stops working owns the way a person finds out.
 *
 * Every state below names its own remedy, the reason is a stable code this
 * codebase owns rather than an upstream message, and a transition alerts
 * exactly once however many workers observe it — the claim is the conditional
 * UPDATE on `healthRevision`, and only the worker that wins it enqueues the
 * alert. See docs/standards/capability-health-alerts.md.
 */

export type HealthTransition = {
  state: BoardSourceHealth
  reason: string | null
  detail?: string | null
  errorCode?: string | null
}

/**
 * Move a source to a health state, once. Returns the new revision when this
 * caller made the transition, and null when the source was already there (or
 * another worker got in first) — so the alert is enqueued by exactly one.
 */
export const claimHealthTransition = async (
  prisma: PrismaClient,
  sourceId: string,
  next: HealthTransition,
): Promise<number | null> => {
  const current = await prisma.boardSource.findUnique({
    where: { id: sourceId },
    select: { healthState: true, healthReason: true, healthRevision: true },
  })
  if (!current) return null
  // Already in this exact state for this exact reason: nothing transitioned,
  // so nothing is announced. This is what stops a failing source alerting on
  // every sweep.
  if (current.healthState === next.state && current.healthReason === (next.reason ?? null)) {
    return null
  }

  const revision = current.healthRevision + 1
  const claimed = await prisma.boardSource.updateMany({
    where: { id: sourceId, healthRevision: current.healthRevision },
    data: {
      healthState: next.state,
      healthReason: next.reason,
      healthDetail: next.detail ?? null,
      healthRevision: revision,
      ...(next.errorCode !== undefined ? { lastErrorCode: next.errorCode } : {}),
    },
  })
  return claimed.count === 1 ? revision : null
}

/** Back to healthy. Recovery is explicit — never a side effect of a login. */
export const clearHealth = async (
  prisma: PrismaClient,
  sourceId: string,
): Promise<void> => {
  await claimHealthTransition(prisma, sourceId, {
    state: 'active',
    reason: null,
    detail: null,
    errorCode: null,
  })
}

/**
 * Who hears about it: the project's administrators, the organisation's owners,
 * and the person whose credential the sync runs under — the three groups who
 * can actually act on any of the remedies.
 */
export const healthAlertRecipients = async (
  prisma: PrismaClient,
  sourceId: string,
): Promise<{ organizationId: string; projectId: string; userIds: string[] }| null> => {
  const source = await prisma.boardSource.findUnique({
    where: { id: sourceId },
    select: {
      organizationId: true,
      projectId: true,
      connection: { select: { ownerUserId: true } },
    },
  })
  if (!source) return null

  const [projectAdmins, orgOwners] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId: source.projectId, role: { in: ['owner', 'admin'] } },
      select: { userId: true },
    }),
    prisma.organizationMember.findMany({
      where: {
        organizationId: source.organizationId,
        role: 'owner',
        deactivatedAt: null,
      },
      select: { userId: true },
    }),
  ])

  const userIds = [
    ...new Set([
      source.connection.ownerUserId,
      ...projectAdmins.map((member) => member.userId),
      ...orgOwners.map((member) => member.userId),
    ]),
  ]
  return { organizationId: source.organizationId, projectId: source.projectId, userIds }
}

/**
 * One durable alert per recipient per transition. The event key carries the
 * revision, so the existing `(user_id, event_key)` uniqueness makes a repeated
 * job a no-op rather than a second bell.
 */
export const writeHealthAlerts = async (
  prisma: PrismaClient,
  input: { sourceId: string; revision: number },
): Promise<number> => {
  const recipients = await healthAlertRecipients(prisma, input.sourceId)
  if (!recipients) return 0
  const eventKey = `board-source-health:${input.sourceId}:${input.revision}`
  const result = await prisma.userAlert.createMany({
    data: recipients.userIds.map((userId) => ({
      organizationId: recipients.organizationId,
      userId,
      kind: 'board_source_health' as const,
      projectId: recipients.projectId,
      boardSourceId: input.sourceId,
      eventKey,
    })),
    skipDuplicates: true,
  })
  return result.count
}
