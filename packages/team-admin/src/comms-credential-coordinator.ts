import { Prisma, type PrismaClient } from '@prisma/client'
import {
  GoogleCapabilityIdSchema,
  type GoogleCapabilityId,
} from '@nessie/schemas'
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
  /** Granted at Google, but switched off locally on this connection. */
  | 'CAPABILITY_BLOCKED'
  /** Two of the caller's accounts qualify; the caller must name one. */
  | 'AMBIGUOUS_ACCOUNT'

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

type LoadedCredential = {
  context: ConnectorConnectionContext
  expiresAt: Date | null
  /** The compare-and-swap token: the credential row as this reader saw it. */
  seenAt: Date
}

/**
 * Read the connection and decrypt its credential. No lock and no transaction:
 * this is a plain read whose result is only ever written back conditionally.
 */
const readConnectionCredential = async (
  prisma: PrismaClient,
  input: { connectionId: string; encryptionSecret: string },
): Promise<LoadedCredential> => {
  const current = await prisma.commsConnection.findUnique({
    where: { id: input.connectionId },
    include: { credential: true },
  })
  if (!current) {
    throw new CommsCredentialCoordinatorError('CONNECTION_NOT_FOUND')
  }
  if (current.status === 'needs_reauthorization') {
    throw new CommsCredentialCoordinatorError('NEEDS_REAUTHORIZATION')
  }
  if (!current.credential) {
    throw new CommsCredentialCoordinatorError('CREDENTIAL_MISSING')
  }
  return {
    context: buildCommsConnectorContext(current, input.encryptionSecret),
    expiresAt: current.credential.expiresAt,
    seenAt: current.credential.updatedAt,
  }
}

/**
 * Store a refreshed bundle only if nobody rotated the row since we read it.
 * Returns false when another refresher won; theirs is as valid as ours.
 */
const storeRefreshedCredential = async (
  prisma: PrismaClient,
  input: {
    connectionId: string
    encryptionSecret: string
    refreshed: CredentialBundle
    seenAt: Date
  },
): Promise<boolean> =>
  prisma.$transaction(async (tx) => {
    const swapped = await tx.commsConnectionCredential.updateMany({
      where: { connectionId: input.connectionId, updatedAt: input.seenAt },
      data: {
        accessTokenCiphertext: sealSecret(
          input.encryptionSecret,
          input.refreshed.accessToken,
        ),
        refreshTokenCiphertext: input.refreshed.refreshToken
          ? sealSecret(input.encryptionSecret, input.refreshed.refreshToken)
          : null,
        expiresAt: parseExpiry(input.refreshed.expiresAt),
        scopeHash: computeScopeHash(input.refreshed.scopes),
      },
    })
    if (swapped.count === 0) return false
    await tx.commsConnection.update({
      where: { id: input.connectionId },
      data: {
        grantedScopes: input.refreshed.scopes as unknown as Prisma.InputJsonValue,
      },
    })
    return true
  })

/**
 * Rotate an expired access token.
 *
 * The OAuth refresh is an outbound HTTPS call to Google/Microsoft and is
 * deliberately made with NO transaction open. It used to run inside a
 * `$transaction` that had already taken `SELECT … FOR UPDATE` on the credential
 * row: a provider that was slow rather than down then held both a pooled
 * connection and a row lock for up to 30s per waiter, and
 * `packages/db/src/index.ts` hands the whole API one client, so one stalled
 * provider degraded everything.
 *
 * Mutual exclusion is replaced by a compare-and-swap on the credential row's
 * `updatedAt` — the pattern `packages/knowledge/src/native-provider.ts` uses for
 * page revisions. A `pg_advisory_xact_lock` would not help here: a
 * transaction-scoped lock cannot span a call made outside a transaction, and a
 * session-scoped one would leak back into the pool still held.
 *
 * If two refreshers race, both call the provider and exactly one write lands.
 * The loser re-reads and returns the winner's credential rather than
 * overwriting it — the stored row is the one every other process will use, so
 * clobbering it is what would actually break a provider that rotates refresh
 * tokens.
 */
const refreshSelectedConnection = async (
  prisma: PrismaClient,
  input: {
    connectionId: string
    connector: CommunicationsConnector
    encryptionSecret: string
    now: Date
  },
): Promise<ConnectorConnectionContext> => {
  const loaded = await readConnectionCredential(prisma, input)
  if (!isExpired(loaded.expiresAt, input.now)) {
    return loaded.context
  }

  let refreshed: CredentialBundle
  try {
    refreshed = persistedRefreshBundle(
      loaded.context,
      await input.connector.refreshCredentials(loaded.context),
    )
  } catch (error) {
    if (!isRejectedCredential(error)) throw error
    await markCommsConnectionNeedsReauthorization(prisma, input.connectionId)
    throw new CommsCredentialCoordinatorError('NEEDS_REAUTHORIZATION')
  }

  const stored = await storeRefreshedCredential(prisma, {
    connectionId: input.connectionId,
    encryptionSecret: input.encryptionSecret,
    refreshed,
    seenAt: loaded.seenAt,
  })
  if (stored) {
    return { ...loaded.context, credential: refreshed }
  }

  // Lost the swap: somebody stored a newer credential while ours was in flight.
  // Read theirs — one query, and it refuses on its own if that writer also
  // marked the connection for reauthorization.
  return (await readConnectionCredential(prisma, input)).context
}

export type LoadUserGoogleCredentialInput = {
  organizationId: string
  userId: string
  /**
   * Every scope the call needs. ALL of them must be granted — `contacts.read`
   * needs two, and a person can grant one and decline the other on Google's
   * consent screen.
   */
  requiredScopes: readonly string[]
  /**
   * The capability being exercised, when the caller has one. Checked against
   * the connection's local blocks: Google cannot partially revoke a grant, so
   * a blocked capability's scope is still live at Google and only this check
   * stops it being used.
   */
  capabilityId?: GoogleCapabilityId
  /**
   * Pin to one account. Without it a user holding two Google accounts that
   * both satisfy the scopes is AMBIGUOUS_ACCOUNT rather than silently the most
   * recently updated one — sending mail from the wrong mailbox is not a
   * recoverable mistake.
   */
  connectionId?: string
  encryptionSecret: string
  connector?: CommunicationsConnector
  now?: Date
}

/** One of the caller's Google accounts, for disambiguation and settings. */
export type UserGoogleConnectionSummary = {
  id: string
  externalUserId: string
  status: string
  grantedScopes: string[]
  disabledCapabilities: GoogleCapabilityId[]
}

const toCapabilityIds = (value: Prisma.JsonValue): GoogleCapabilityId[] =>
  toStringArray(value).filter(
    (entry): entry is GoogleCapabilityId =>
      GoogleCapabilityIdSchema.safeParse(entry).success,
  )

/**
 * The caller's own Google accounts, scoped to their organization AND user id —
 * the same pair every credential read uses, so a listing can never widen past
 * what loading one would allow.
 */
export const listUserGoogleConnections = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<UserGoogleConnectionSummary[]> => {
  const rows = await prisma.commsConnection.findMany({
    where: {
      organizationId: input.organizationId,
      ownerUserId: input.userId,
      provider: 'google',
      status: { not: 'disconnected' },
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      externalUserId: true,
      status: true,
      grantedScopes: true,
      disabledCapabilities: true,
    },
  })
  return rows.map((row) => ({
    id: row.id,
    externalUserId: row.externalUserId,
    status: row.status,
    grantedScopes: toStringArray(row.grantedScopes),
    disabledCapabilities: toCapabilityIds(row.disabledCapabilities),
  }))
}

/**
 * Load the one active Google account satisfying every required scope, decrypt
 * only that selected row, and serialize an expired-token refresh through a
 * database row lock so API and worker processes cannot rotate it concurrently.
 *
 * Fails closed at each step: no connection, a scope the grant does not carry, a
 * locally blocked capability, or two equally-valid accounts are all typed
 * refusals, never a best guess.
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
      ...(input.connectionId ? { id: input.connectionId } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      status: true,
      grantedScopes: true,
      disabledCapabilities: true,
    },
  })
  if (connections.length === 0) {
    throw new CommsCredentialCoordinatorError('CONNECTION_NOT_FOUND')
  }

  const scoped = connections.filter((connection) => {
    const granted = new Set(toStringArray(connection.grantedScopes))
    return input.requiredScopes.every((scope) => granted.has(scope))
  })

  // A blocked capability is reported distinctly from a missing scope: the
  // remedy is different (unblock here vs. grant at Google), and telling someone
  // to re-consent for a scope they already granted is a dead end.
  const blocked = input.capabilityId
  const allowed = blocked
    ? scoped.filter(
        (connection) =>
          !toCapabilityIds(connection.disabledCapabilities).includes(blocked),
      )
    : scoped
  if (blocked && scoped.length > 0 && allowed.length === 0) {
    throw new CommsCredentialCoordinatorError('CAPABILITY_BLOCKED')
  }

  const active = allowed.filter((connection) => connection.status === 'active')
  if (active.length > 1) {
    throw new CommsCredentialCoordinatorError('AMBIGUOUS_ACCOUNT')
  }
  const selected = active[0]
  if (!selected) {
    if (allowed.some((connection) =>
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
