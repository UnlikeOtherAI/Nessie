import type { Prisma } from '@prisma/client'

// Sentinel thrown by the membership mutators when a change would remove the last
// active owner; routes translate it to a 400 LAST_OWNER.
export const LAST_OWNER_ERROR = 'LAST_OWNER'

/**
 * Lock the org's active-owner rows FOR UPDATE and return their user ids. Called
 * inside the same transaction as an ownership-reducing write so two concurrent
 * owner-removals serialize on these rows — the second blocks until the first
 * commits, then re-reads the reduced set — preventing a race that would strand
 * the org with zero active owners.
 *
 * Shared by the local membership mutators (`users.ts`) and the UOA role
 * projection (`uoa-roles.ts`): both reduce ownership and must serialize on the
 * same rows, so there is exactly one implementation of the lock.
 */
export const lockActiveOwnerUserIds = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string[]> => {
  const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id FROM organization_members
    WHERE organization_id = ${organizationId}::uuid
      AND role = 'owner' AND deactivated_at IS NULL
    FOR UPDATE`
  return rows.map((row) => row.user_id)
}

/** True when removing `userId` from active ownership leaves no active owner. */
export const wouldRemoveLastOwner = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const ownerIds = await lockActiveOwnerUserIds(tx, organizationId)
  return ownerIds.includes(userId) && ownerIds.length <= 1
}

// Throw LAST_OWNER_ERROR if removing `userId` from active ownership (via demotion
// or deactivation) would leave the org with no active owner.
export const assertNotLastOwner = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
): Promise<void> => {
  if (await wouldRemoveLastOwner(tx, organizationId, userId)) {
    throw new Error(LAST_OWNER_ERROR)
  }
}
