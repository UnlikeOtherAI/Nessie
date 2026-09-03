import type { PrismaClient } from '@prisma/client'

/**
 * Resolve UOA subjects to the local Nessie principal ids **inside one
 * organization**.
 *
 * `User.uoaSub` is unique GLOBALLY, so the obvious query —
 * `user.findMany({ where: { uoaSub: { in: subs } } })` — returns a local user id
 * for somebody who signed into a *different* organization on the same instance
 * and holds no membership here. That hands this organization a Nessie principal
 * id for a stranger, and anything keyed on it (agent ownership, mentions,
 * direct messages) would then point across a tenant boundary.
 *
 * The membership predicate is therefore not an optimisation; it is the tenancy
 * boundary. A returned `userId` means "the local row **in this organization**,
 * when one exists" — never an identity claim about the subject.
 *
 * Deactivated members are still resolved: they are real principals in this
 * organization whose rows must still render (as departed) rather than vanish.
 * Callers that need liveness read it separately, the way ownership does.
 */
export const resolveLocalUserIdsByUoaSub = async (
  prisma: PrismaClient,
  organizationId: string,
  uoaSubs: readonly string[],
): Promise<Map<string, string>> => {
  const subs = [...new Set(uoaSubs.filter((sub) => sub.length > 0))]
  if (subs.length === 0) return new Map()

  const users = await prisma.user.findMany({
    where: {
      organizationMembers: { some: { organizationId } },
      uoaSub: { in: subs },
    },
    select: { id: true, uoaSub: true },
  })

  return new Map(
    users
      .filter((user): user is { id: string; uoaSub: string } => user.uoaSub !== null)
      .map((user) => [user.uoaSub, user.id]),
  )
}
