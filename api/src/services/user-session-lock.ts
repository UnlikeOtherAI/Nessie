import { Prisma, type PrismaClient } from '@prisma/client'

type UserSessionLockStore = Pick<Prisma.TransactionClient, '$queryRaw'>

export const AUTH_LOCK_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 20_000,
} as const

/**
 * Serialize session issuance, security-sensitive credential changes, and
 * user-wide revocation for one local user across every API replica.
 */
export const lockUserSessions = async (
  tx: UserSessionLockStore,
  userId: string,
): Promise<void> => {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`nessie:user-sessions:${userId}`}, 0)
      )
    ) AS acquired
  `)
}

export type UserSessionLockPrisma = Pick<
  PrismaClient,
  '$transaction' | 'refreshToken' | 'uoaSessionCredential' | 'user'
>
