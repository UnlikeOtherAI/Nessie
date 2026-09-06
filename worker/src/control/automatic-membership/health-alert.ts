/**
 * Telling somebody when an automatic-membership rule stops working.
 *
 * `docs/standards/capability-health-alerts.md`: "A capability that can stop
 * working owns the way a person finds out." The obligation sits on the
 * **transition**, and the alert must be exactly once per transition — which is
 * what `health_revision` plus the existing `user_alerts (user_id, event_key)`
 * uniqueness buys, with no second marker table.
 *
 * Without this, a rule whose authorizing administrator lost access goes quiet
 * and is discovered only by someone happening to open the tab — the precise
 * failure that standard was written after (a recurring trigger dead and silent
 * for nineteen days).
 */

import type { PrismaClient } from '@prisma/client'

/** Who can actually repair it: the organisation's active owners and admins. */
const repairers = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<string[]> => {
  const members = await prisma.organizationMember.findMany({
    select: { userId: true },
    where: {
      deactivatedAt: null,
      organizationId,
      role: { in: ['owner', 'admin'] },
    },
  })
  return members.map((member) => member.userId)
}

/**
 * Alert once per health revision. The revision is in the event key, so a rule
 * that lapses, is repaired and lapses again alerts twice, while a long
 * reconciliation hitting the same refusal on every person alerts once.
 */
export const alertAutomaticMembershipHealth = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    ruleId: string
    healthRevision: number
    teamName: string
    reason: string
  },
): Promise<number> => {
  try {
    const userIds = await repairers(prisma, input.organizationId)
    if (userIds.length === 0) return 0

    const eventKey = `automatic-membership:rule:${input.ruleId}:${input.healthRevision}`
    const created = await prisma.userAlert.createMany({
      // `(userId, eventKey)` is unique, so a replayed job re-alerts nobody.
      data: userIds.map((userId) => ({
        // The relation is what lets the alert clear itself on repair.
        automaticMembershipRuleId: input.ruleId,
        eventKey,
        kind: 'automatic_membership_health' as const,
        metadata: {
          reason: input.reason.slice(0, 500),
          ruleId: input.ruleId,
          teamName: input.teamName,
        },
        organizationId: input.organizationId,
        userId,
      })),
      skipDuplicates: true,
    })
    return created.count
  } catch (error) {
    // Alerting must never take down the work it describes.
    console.error('automatic membership: health alert failed', error)
    return 0
  }
}
