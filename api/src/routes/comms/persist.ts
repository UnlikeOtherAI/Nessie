import type { PrismaClient } from '@prisma/client'
import {
  computeScopeHash,
  sealSecret,
  type ConnectResult,
  type CommsProviderId,
} from '@nessie/comms-connect'

import { toInputJson } from '../../db/prisma-json.js'

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
  /**
   * The capability ids this authorization asked for. Recorded so the UI can
   * distinguish "asked for and declined" from "never asked" — it is never an
   * authority for what the connection may do; `grantedScopes` is.
   */
  requestedCapabilities?: readonly string[]
}

export const persistConnectedAccount = async (
  prisma: PrismaClient,
  input: PersistConnectedAccountInput,
): Promise<string> => {
  const { connect, encryptionSecret } = input
  const grantedScopes = toInputJson(connect.grantedScopes)
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
  const requestedCapabilities = toInputJson([
    ...(input.requestedCapabilities ?? []),
  ])

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
        requestedCapabilities,
        ...(connect.providerAccountId
          ? { providerAccountId: connect.providerAccountId }
          : {}),
      },
      update: {
        status: 'active',
        grantedScopes,
        requestedCapabilities,
        // Backfills the stable provider account id on a connection made before
        // identity moved to the id_token. Local capability blocks are
        // deliberately preserved: re-authorizing widens the grant at Google and
        // must not quietly switch a capability the person turned off here.
        ...(connect.providerAccountId
          ? { providerAccountId: connect.providerAccountId }
          : {}),
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
        ...(refreshTokenCiphertext ? { refreshTokenCiphertext } : {}),
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
