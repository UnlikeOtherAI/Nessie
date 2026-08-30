import { Prisma, type PrismaClient } from '@prisma/client'
import {
  computeScopeHash,
  openSecret,
  resolveConnector,
  sealSecret,
  type CommunicationsConnector,
  type ConnectorConnectionContext,
  type CredentialBundle,
} from '@nessie/comms-connect'

type ConnectionWithCredential = Prisma.CommsConnectionGetPayload<{
  include: { credential: true }
}>

export type CommsCredentialCoordinatorErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CREDENTIAL_MISSING'
  | 'SCOPE_MISSING'
  | 'NEEDS_REAUTHORIZATION'

export class CommsCredentialCoordinatorError extends Error {
  readonly code: CommsCredentialCoordinatorErrorCode

  constructor(code: CommsCredentialCoordinatorErrorCode) {
    super(`[comms-credential] ${code.toLowerCase().replaceAll('_', ' ')}`)
    this.name = 'CommsCredentialCoordinatorError'
    this.code = code
  }
}

const toStringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

/**
 * The one DB-row-to-connector mapper used by API and worker code. Plaintext is
 * produced only for the selected credential and remains inside the process.
 */
export const buildCommsConnectorContext = (
  connection: ConnectionWithCredential,
  encryptionSecret: string,
): ConnectorConnectionContext => {
  if (!connection.credential) {
    throw new CommsCredentialCoordinatorError('CREDENTIAL_MISSING')
  }
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    ownerUserId: connection.ownerUserId,
    provider: connection.provider,
    externalTenantId: connection.externalTenantId,
    externalUserId: connection.externalUserId,
    credential: {
      accessToken: openSecret(
        encryptionSecret,
        connection.credential.accessTokenCiphertext,
      ),
      refreshToken: connection.credential.refreshTokenCiphertext
        ? openSecret(
            encryptionSecret,
            connection.credential.refreshTokenCiphertext,
          )
        : undefined,
      expiresAt: connection.credential.expiresAt?.toISOString(),
      scopes: toStringArray(connection.grantedScopes),
    },
  }
}

const isExpired = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime()

const isRejectedCredential = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'needsReauthorization' in error
  && (error as { needsReauthorization: unknown }).needsReauthorization === true

const parseExpiry = (expiresAt: string | undefined): Date | null => {
  if (!expiresAt) return null
  const parsed = new Date(expiresAt)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('[comms-credential] provider returned an invalid expiry')
  }
  return parsed
}

const persistedRefreshBundle = (
  current: ConnectorConnectionContext,
  refreshed: CredentialBundle,
): CredentialBundle => ({
  ...refreshed,
  refreshToken: refreshed.refreshToken ?? current.credential.refreshToken,
})

type RefreshResult =
  | { kind: 'credential'; context: ConnectorConnectionContext }
  | { kind: 'reauthorization-required' }

const refreshSelectedConnection = async (
  prisma: PrismaClient,
  input: {
    connectionId: string
    connector: CommunicationsConnector
    encryptionSecret: string
    now: Date
  },
): Promise<ConnectorConnectionContext> => {
  const result = await prisma.$transaction(async (tx): Promise<RefreshResult> => {
    await tx.$queryRaw`
      SELECT id
      FROM comms_connection_credentials
      WHERE connection_id = ${input.connectionId}::uuid
      FOR UPDATE
    `
    const current = await tx.commsConnection.findUnique({
      where: { id: input.connectionId },
      include: { credential: true },
    })
    if (!current) {
      throw new CommsCredentialCoordinatorError('CONNECTION_NOT_FOUND')
    }
    if (current.status === 'needs_reauthorization') {
      return { kind: 'reauthorization-required' }
    }
    if (!current.credential) {
      throw new CommsCredentialCoordinatorError('CREDENTIAL_MISSING')
    }
    const context = buildCommsConnectorContext(current, input.encryptionSecret)
    if (!isExpired(current.credential.expiresAt, input.now)) {
      return { kind: 'credential', context }
    }

    let refreshed: CredentialBundle
    try {
      refreshed = persistedRefreshBundle(
        context,
        await input.connector.refreshCredentials(context),
      )
    } catch (error) {
      if (!isRejectedCredential(error)) throw error
      await tx.commsConnection.update({
        where: { id: current.id },
        data: { status: 'needs_reauthorization' },
      })
      return { kind: 'reauthorization-required' }
    }

    const grantedScopes = refreshed.scopes as unknown as Prisma.InputJsonValue
    await tx.commsConnection.update({
      where: { id: current.id },
      data: { grantedScopes },
    })
    await tx.commsConnectionCredential.update({
      where: { connectionId: current.id },
      data: {
        accessTokenCiphertext: sealSecret(
          input.encryptionSecret,
          refreshed.accessToken,
        ),
        refreshTokenCiphertext: refreshed.refreshToken
          ? sealSecret(input.encryptionSecret, refreshed.refreshToken)
          : null,
        expiresAt: parseExpiry(refreshed.expiresAt),
        scopeHash: computeScopeHash(refreshed.scopes),
      },
    })
    return {
      kind: 'credential',
      context: { ...context, credential: refreshed },
    }
  }, { timeout: 30_000 })

  if (result.kind === 'reauthorization-required') {
    throw new CommsCredentialCoordinatorError('NEEDS_REAUTHORIZATION')
  }
  return result.context
}

export type LoadUserGoogleCredentialInput = {
  organizationId: string
  userId: string
  requiredScope: string
  encryptionSecret: string
  connector?: CommunicationsConnector
  now?: Date
}

/**
 * Load the newest active Google account holding `requiredScope`, decrypt only
 * that selected row, and serialize an expired-token refresh through a database
 * row lock so API and worker processes cannot rotate it concurrently.
 */
export const loadUserGoogleCommsCredential = async (
  prisma: PrismaClient,
  input: LoadUserGoogleCredentialInput,
): Promise<ConnectorConnectionContext> => {
  const connections = await prisma.commsConnection.findMany({
    where: {
      organizationId: input.organizationId,
      ownerUserId: input.userId,
      provider: 'google',
      status: { not: 'disconnected' },
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, status: true, grantedScopes: true },
  })
  if (connections.length === 0) {
    throw new CommsCredentialCoordinatorError('CONNECTION_NOT_FOUND')
  }

  const scoped = connections.filter((connection) =>
    toStringArray(connection.grantedScopes).includes(input.requiredScope),
  )
  const selected = scoped.find((connection) => connection.status === 'active')
  if (!selected) {
    if (scoped.some((connection) =>
      connection.status === 'needs_reauthorization')) {
      throw new CommsCredentialCoordinatorError('NEEDS_REAUTHORIZATION')
    }
    throw new CommsCredentialCoordinatorError('SCOPE_MISSING')
  }

  const loaded = await prisma.commsConnection.findUnique({
    where: { id: selected.id },
    include: { credential: true },
  })
  if (!loaded) {
    throw new CommsCredentialCoordinatorError('CONNECTION_NOT_FOUND')
  }
  if (!loaded.credential) {
    throw new CommsCredentialCoordinatorError('CREDENTIAL_MISSING')
  }
  const now = input.now ?? new Date()
  if (!isExpired(loaded.credential.expiresAt, now)) {
    return buildCommsConnectorContext(loaded, input.encryptionSecret)
  }
  return refreshSelectedConnection(prisma, {
    connectionId: loaded.id,
    connector: input.connector ?? resolveConnector('google'),
    encryptionSecret: input.encryptionSecret,
    now,
  })
}

/** Atomically stop future use of a provider-rejected connection. */
export const markCommsConnectionNeedsReauthorization = async (
  prisma: PrismaClient,
  connectionId: string,
): Promise<void> => {
  await prisma.commsConnection.updateMany({
    where: { id: connectionId, status: { not: 'disconnected' } },
    data: { status: 'needs_reauthorization' },
  })
}
