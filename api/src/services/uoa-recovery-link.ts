import type { Prisma, PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import { AUTH_LOCK_TRANSACTION_OPTIONS, lockUserSessions } from './user-session-lock.js'
import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'

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
  workspaceDirectory?: UoaWorkspaceDirectoryEntry[]
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
 * after the exact external-workspace lock and before the target
 * existing-or-create branch and every project/team/channel/membership write:
 * conditionally claim the exact Nessie link row (this local org, this user,
 * this product, linked, same subject, and a NON-NULL safe nonnegative epoch
 * no newer than the returned one — a null stored epoch never claims),
 * advancing its epoch and refreshing the non-authoritative current UOA
 * directory + active tuple. The claim's row lock is held through every
 * write below it in the transaction; zero rows claimed aborts it all.
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
  const metadata = existing?.metadata
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
        ...(input.workspaceDirectory
          ? { workspaceDirectory: input.workspaceDirectory }
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
