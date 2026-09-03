import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { AUTH_LOCK_TRANSACTION_OPTIONS, lockUserSessions } from './user-session-lock.js'
import type { UoaTeamDirectoryEntry } from './uoa-team-directory.js'

export class UoaRecoveryAccountLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UoaRecoveryAccountLinkError'
  }
}

export type UoaRecoveryLinkFenceInput = {
  /** The exact local org the bearer holds, passed as a claim — never looked up. */
  localOrganizationId: string
  userId: string
  subject: string
  /** UOA's epoch for this exchange, already validated non-null + monotonic. */
  returnedTokenVersion: number
  /** Non-authoritative last-seen directory/active tuple from the exchange. */
  identity: UoaSessionIdentity
  teamDirectory?: UoaTeamDirectoryEntry[]
}

/**
 * Pre-billing recovery fence: read-ONLY proof, under the user-session lock,
 * that the durable Nessie account link still matches the credential this
 * recovery would mint (linked, same subject, valid epoch <= the returned
 * one). The authoritative fence is the conditional claim inside
 * `claimUoaRecoveryAccountLink` — this read only spares a billing POST whose
 * outcome the resolver transaction would refuse anyway.
 */
export const assertUoaRecoveryAccountLink = async (
  prisma: PrismaClient,
  input: UoaRecoveryLinkFenceInput,
): Promise<void> => {
  await prisma.$transaction(async (transaction) => {
    await lockUserSessions(transaction, input.userId)
    const link = await transaction.productAccountLink.findUnique({
      where: {
        organizationId_userId_productSlug: {
          organizationId: input.localOrganizationId,
          productSlug: 'nessie',
          userId: input.userId,
        },
      },
      select: {
        status: true,
        uoaSub: true,
        uoaTokenVersion: true,
      },
    })
    if (
      link?.status !== 'linked'
      || link.uoaSub !== input.subject
      || link.uoaTokenVersion === null
      || !Number.isSafeInteger(link.uoaTokenVersion)
      || link.uoaTokenVersion < 0
      || link.uoaTokenVersion > input.returnedTokenVersion
    ) {
      throw new UoaRecoveryAccountLinkError(
        'The Nessie account link no longer matches this UnlikeOtherAI session.',
      )
    }
  }, AUTH_LOCK_TRANSACTION_OPTIONS)
}

/**
 * Authoritative recovery fence, run INSIDE the single recovery transaction
 * after the exact external-org + external-team locks and before the
 * target existing-or-create branch and every project/team/channel/membership
 * write. `localOrganizationId` is the resolved TARGET organization (per-UOA-org
 * model — for a cross-org reauthorization it differs from the bearer's source
 * org, whose link the read-only pre-billing assert checked). Two shapes:
 *
 * - A link row exists in the target org → conditionally claim it (linked, same
 *   subject, NON-NULL safe nonnegative epoch no newer than the returned one —
 *   a null stored epoch never claims), advancing its epoch and refreshing the
 *   non-authoritative directory + active tuple. Zero rows claimed aborts the
 *   whole transaction; the claimed row lock is held through every write below.
 * - No row exists (first entry into the target org — possibly materialized by
 *   this very recovery) → CREATE it linked at the returned epoch, exactly as a
 *   first login's link sync would. There is no older state to fence against,
 *   and the unique (org, user, product) key turns a concurrent duplicate
 *   create into a transaction abort rather than a second row.
 */
export const claimUoaRecoveryAccountLink = async (
  transaction: Prisma.TransactionClient,
  input: UoaRecoveryLinkFenceInput,
): Promise<void> => {
  const existing = await transaction.productAccountLink.findUnique({
    where: {
      organizationId_userId_productSlug: {
        organizationId: input.localOrganizationId,
        productSlug: 'nessie',
        userId: input.userId,
      },
    },
    select: { metadata: true },
  })
  if (!existing) {
    await transaction.productAccountLink.create({
      data: {
        organizationId: input.localOrganizationId,
        userId: input.userId,
        productSlug: 'nessie',
        status: 'linked',
        uoaSub: input.subject,
        uoaTokenVersion: input.returnedTokenVersion,
        externalAccountId: input.subject,
        activeOrgId: input.identity.organizationId,
        activeTeamId: input.identity.teamId,
        lastVerifiedAt: new Date(),
        metadata: {
          provider: 'uoa',
          ...(input.teamDirectory
            ? { teamDirectory: input.teamDirectory }
            : {}),
        },
      },
    })
    return
  }
  const metadata = existing.metadata
    && typeof existing.metadata === 'object'
    && !Array.isArray(existing.metadata)
    ? existing.metadata as Prisma.JsonObject
    : {}
  const claimed = await transaction.productAccountLink.updateMany({
    where: {
      organizationId: input.localOrganizationId,
      productSlug: 'nessie',
      status: 'linked',
      uoaSub: input.subject,
      userId: input.userId,
      uoaTokenVersion: { gte: 0, lte: input.returnedTokenVersion, not: null },
    },
    data: {
      activeOrgId: input.identity.organizationId,
      activeTeamId: input.identity.teamId,
      lastVerifiedAt: new Date(),
      metadata: {
        ...metadata,
        ...(input.teamDirectory
          ? { teamDirectory: input.teamDirectory }
          : {}),
      },
      uoaTokenVersion: input.returnedTokenVersion,
    },
  })
  if (claimed.count !== 1) {
    throw new UoaRecoveryAccountLinkError(
      'The Nessie account link changed while the recovery was completing.',
    )
  }
}
