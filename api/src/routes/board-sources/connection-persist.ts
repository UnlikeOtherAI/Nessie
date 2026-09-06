import type { PrismaClient } from '@prisma/client'
import type { BoardSourceProvider, ConnectResult } from '@nessie/board-sources'
import { storeBoardSourceCredential } from '@nessie/team-admin'

/**
 * Writing a verified connection down — the one place any of the three ways in
 * lands: the OAuth callback, Trello's fragment submission, and a pasted API key.
 *
 * They differ only in how they obtained the `ConnectResult`; everything after
 * that is identical, and was already written twice before a third caller made
 * the duplication worth removing. The upsert key is the account itself, so
 * reconnecting the same workspace re-credentials the existing connection rather
 * than growing a second row that every source would then have to be re-pointed at.
 */
export type PersistConnectionInput = {
  organizationId: string
  ownerUserId: string
  provider: BoardSourceProvider
  authMethod: 'oauth' | 'api_key'
  result: ConnectResult
  encryptionSecret: string
}

export const persistBoardSourceConnection = async (
  prisma: PrismaClient,
  input: PersistConnectionInput,
): Promise<{ id: string }> => {
  const { organizationId, ownerUserId, provider, authMethod, result } = input

  const connection = await prisma.boardSourceConnection.upsert({
    where: {
      organizationId_ownerUserId_provider_externalAccountId_externalTenantId: {
        organizationId,
        ownerUserId,
        provider,
        externalAccountId: result.externalAccountId,
        externalTenantId: result.externalTenantId,
      },
    },
    create: {
      organizationId,
      ownerUserId,
      provider,
      authMethod,
      externalAccountId: result.externalAccountId,
      externalTenantId: result.externalTenantId,
      grantedScopes: result.grantedScopes,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
    update: {
      // A connection reconnected by a different method is now that method: the
      // remedy offered next time has to match the credential actually stored.
      authMethod,
      grantedScopes: result.grantedScopes,
      status: 'active',
      lastVerifiedAt: new Date(),
    },
  })

  await storeBoardSourceCredential(
    prisma,
    connection.id,
    result.credential,
    input.encryptionSecret,
  )

  // Everything this connection runs is healthy again by construction: the
  // credential that made them fail has just been replaced.
  await prisma.boardSource.updateMany({
    where: { connectionId: connection.id, healthState: 'needs_reauthorization' },
    data: { healthState: 'active', healthReason: null, nextRunAt: new Date() },
  })

  return { id: connection.id }
}
