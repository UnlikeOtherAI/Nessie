import type { PrismaClient, Prisma } from '@prisma/client'
import {
  computeScopeHash,
  sealSecret,
  type ConnectResult,
  type CommsProviderId,
} from '@nessie/comms-connect'

/**
 * Persist the outcome of a successful provider `connect()` into durable state:
 * the `CommsConnection` identity, its encrypted `CommsConnectionCredential`, and
 * a pending connection-level history `CommsSyncJob` the worker will resume.
 *
 * Tokens are sealed with the same shared secret-crypto seam the worker uses to
 * open them; plaintext never leaves this call. Re-connecting the same provider
 * identity updates the existing rows (idempotent on the connection's natural
 * key) and re-activates a previously disconnected connection.
 */
export type PersistConnectedAccountInput = {
  encryptionSecret: string
  organizationId: string
  userId: string
  provider: CommsProviderId
  connect: ConnectResult
}

export const persistConnectedAccount = async (
  prisma: PrismaClient,
  input: PersistConnectedAccountInput,
): Promise<string> => {
  const { connect, encryptionSecret } = input
  const grantedScopes = connect.grantedScopes as unknown as Prisma.InputJsonValue
  const accessTokenCiphertext = sealSecret(
    encryptionSecret,
    connect.credential.accessToken,
  )
  const refreshTokenCiphertext = connect.credential.refreshToken
    ? sealSecret(encryptionSecret, connect.credential.refreshToken)
    : null
  const expiresAt = connect.credential.expiresAt
    ? new Date(connect.credential.expiresAt)
    : null
  const scopeHash = computeScopeHash(connect.credential.scopes)

  return prisma.$transaction(async (tx) => {
    const connection = await tx.commsConnection.upsert({
      where: {
        organizationId_ownerUserId_provider_externalTenantId_externalUserId: {
          organizationId: input.organizationId,
          ownerUserId: input.userId,
          provider: input.provider,
          externalTenantId: connect.externalTenantId,
          externalUserId: connect.externalUserId,
        },
      },
      create: {
        organizationId: input.organizationId,
        ownerUserId: input.userId,
        provider: input.provider,
        externalTenantId: connect.externalTenantId,
        externalUserId: connect.externalUserId,
        status: 'active',
        grantedScopes,
      },
      update: {
        status: 'active',
        grantedScopes,
      },
    })

    await tx.commsConnectionCredential.upsert({
      where: { connectionId: connection.id },
      create: {
        connectionId: connection.id,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        scopeHash,
      },
      update: {
        accessTokenCiphertext,
        refreshTokenCiphertext,
        expiresAt,
        scopeHash,
      },
    })

    // Seed a connection-level history job only when there is no live one; the
    // worker's `getOrCreateSyncJob` resumes a pending/failed row instead of
    // restarting, so re-connecting does not duplicate the back-fill.
    const existing = await tx.commsSyncJob.findFirst({
      where: {
        connectionId: connection.id,
        resourceId: null,
        phase: 'history',
        status: { in: ['pending', 'running'] },
      },
      select: { id: true },
    })
    if (!existing) {
      await tx.commsSyncJob.create({
        data: {
          connectionId: connection.id,
          phase: 'history',
          status: 'pending',
        },
      })
    }

    return connection.id
  })
}
