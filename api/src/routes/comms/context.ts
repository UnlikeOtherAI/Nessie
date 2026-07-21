import type { Prisma } from '@prisma/client'
import {
  openSecret,
  type ConnectorConnectionContext,
} from '@nessie/comms-connect'

/**
 * Build the decrypted connector context the API needs for the best-effort
 * provider revoke during disconnect. Mirrors the worker's `toConnectorContext`
 * but lives here because that helper is worker-package-private; both decrypt
 * through the same shared `openSecret` seam, and the plaintext never leaves the
 * process.
 */
type ConnectionWithCredential = Prisma.CommsConnectionGetPayload<{
  include: { credential: true }
}>

const toStringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

export const buildConnectorContext = (
  connection: ConnectionWithCredential,
  encryptionSecret: string,
): ConnectorConnectionContext => {
  if (!connection.credential) {
    throw new Error(`[comms] connection ${connection.id} has no stored credential`)
  }
  const { credential } = connection
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    ownerUserId: connection.ownerUserId,
    provider: connection.provider,
    externalTenantId: connection.externalTenantId,
    externalUserId: connection.externalUserId,
    credential: {
      accessToken: openSecret(encryptionSecret, credential.accessTokenCiphertext),
      refreshToken: credential.refreshTokenCiphertext
        ? openSecret(encryptionSecret, credential.refreshTokenCiphertext)
        : undefined,
      expiresAt: credential.expiresAt?.toISOString(),
      scopes: toStringArray(connection.grantedScopes),
    },
  }
}
