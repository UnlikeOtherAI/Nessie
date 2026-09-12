import type { PrismaClient } from '@prisma/client'

import { hashRefreshToken } from './refresh-token-crypto.js'
import { revokeRefreshFamily } from './refresh-token-family.js'

/**
 * Revoke the family of a presented token. Unknown tokens deliberately remain a
 * no-op so logout is idempotent, while the caller still learns whom to evict
 * from its access-token cache after a real revocation.
 */
export const revokeRefreshTokenByRaw = async (
  prisma: PrismaClient,
  rawToken: string,
): Promise<{ userId: string } | null> => {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { familyId: true, userId: true },
  })
  if (!record) return null
  await revokeRefreshFamily(prisma, record.familyId)
  return { userId: record.userId }
}
