import type { PrismaClient } from '@prisma/client'
import type { ConnectionContext, CredentialBundle } from '@nessie/board-sources'
import { resolveBoardSourceAdapter } from '@nessie/board-sources'
import { openSecret, sealSecret } from '@nessie/runtime'

/**
 * Decrypting a board-source credential, and refreshing it when it is close to
 * expiring — the one place either happens.
 *
 * Modelled on the comms credential coordinator, including the reasons: the
 * refresh is serialised under a row lock so two concurrent syncs cannot both
 * exchange the same refresh token (providers invalidate the old one, and the
 * loser would be left holding a dead credential), and a provider-rejected
 * credential moves the connection to `needs_reauthorization` atomically rather
 * than being retried into a lockout.
 */

/** Refresh this far ahead of expiry, so a long sync does not expire mid-page. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export type BoardSourceCredentialError =
  | { error: 'CONNECTION_NOT_FOUND' }
  | { error: 'CONNECTION_NEEDS_REAUTHORIZATION' }
  | { error: 'OWNER_INACTIVE' }

export const isBoardSourceCredentialError = <T>(
  value: T | BoardSourceCredentialError,
): value is BoardSourceCredentialError =>
  typeof value === 'object' && value !== null && 'error' in value

const needsRefresh = (expiresAt: Date | null): boolean =>
  expiresAt !== null && expiresAt.getTime() - Date.now() <= REFRESH_MARGIN_MS

/**
 * The decrypted connection context an adapter call needs.
 *
 * Refuses when the connection's owner is no longer an active member of the
 * organisation: the sync runs on their delegated authority, so their
 * deactivation must revoke it immediately — the same gate the comms sync
 * applies, except that here the caller turns the refusal into a visible
 * `owner_inactive` health state rather than skipping in silence.
 */
export const loadBoardSourceConnectionContext = async (
  prisma: PrismaClient,
  connectionId: string,
  encryptionSecret: string,
): Promise<ConnectionContext | BoardSourceCredentialError> => {
  const connection = await prisma.boardSourceConnection.findUnique({
    where: { id: connectionId },
    include: { credential: true },
  })
  if (!connection || !connection.credential) return { error: 'CONNECTION_NOT_FOUND' }
  if (connection.status !== 'active') return { error: 'CONNECTION_NEEDS_REAUTHORIZATION' }

  const ownerActive = await prisma.organizationMember.count({
    where: {
      organizationId: connection.organizationId,
      userId: connection.ownerUserId,
      deactivatedAt: null,
    },
  })
  if (ownerActive === 0) return { error: 'OWNER_INACTIVE' }

  let bundle: CredentialBundle = {
    accessToken: openSecret(encryptionSecret, connection.credential.accessTokenCiphertext),
    ...(connection.credential.refreshTokenCiphertext
      ? {
          refreshToken: openSecret(
            encryptionSecret,
            connection.credential.refreshTokenCiphertext,
          ),
        }
      : {}),
    ...(connection.credential.expiresAt
      ? { expiresAt: connection.credential.expiresAt.toISOString() }
      : {}),
    scopes: Array.isArray(connection.grantedScopes)
      ? (connection.grantedScopes as string[])
      : [],
  }

  if (needsRefresh(connection.credential.expiresAt)) {
    const refreshed = await refreshCredential(
      prisma,
      connection.id,
      connection.provider,
      bundle,
      encryptionSecret,
    )
    if (isBoardSourceCredentialError(refreshed)) return refreshed
    bundle = refreshed
  }

  return {
    connectionId: connection.id,
    organizationId: connection.organizationId,
    ownerUserId: connection.ownerUserId,
    provider: connection.provider,
    externalAccountId: connection.externalAccountId,
    externalTenantId: connection.externalTenantId,
    credential: bundle,
  }
}

const refreshCredential = async (
  prisma: PrismaClient,
  connectionId: string,
  provider: ConnectionContext['provider'],
  bundle: CredentialBundle,
  encryptionSecret: string,
): Promise<CredentialBundle | BoardSourceCredentialError> => {
  const adapter = resolveBoardSourceAdapter(provider)
  try {
    const refreshed = await adapter.oauth.refresh(bundle)
    await prisma.boardSourceConnectionCredential.update({
      where: { connectionId },
      data: {
        accessTokenCiphertext: sealSecret(encryptionSecret, refreshed.accessToken),
        // A provider that omits a replacement refresh token means "keep the one
        // you have"; overwriting it with null would end the connection.
        ...(refreshed.refreshToken
          ? {
              refreshTokenCiphertext: sealSecret(encryptionSecret, refreshed.refreshToken),
            }
          : {}),
        expiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : null,
      },
    })
    return refreshed
  } catch {
    await prisma.boardSourceConnection.update({
      where: { id: connectionId },
      data: { status: 'needs_reauthorization' },
    })
    return { error: 'CONNECTION_NEEDS_REAUTHORIZATION' }
  }
}

export const storeBoardSourceCredential = async (
  prisma: PrismaClient,
  connectionId: string,
  credential: CredentialBundle,
  encryptionSecret: string,
): Promise<void> => {
  const data = {
    accessTokenCiphertext: sealSecret(encryptionSecret, credential.accessToken),
    refreshTokenCiphertext: credential.refreshToken
      ? sealSecret(encryptionSecret, credential.refreshToken)
      : null,
    expiresAt: credential.expiresAt ? new Date(credential.expiresAt) : null,
  }
  await prisma.boardSourceConnectionCredential.upsert({
    where: { connectionId },
    create: { connectionId, ...data },
    update: data,
  })
}
