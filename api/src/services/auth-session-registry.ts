import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * The `AuthSession` registry is the revocation authority for a login session
 * (security hardening workstream 1e, S9/SB-04). The refresh-token family table
 * cannot serve that role — every rotation revokes the family's predecessor
 * rows, so family revocation state never outlives a rotation — while the
 * access JWT's `sid` claim stays stable across the whole rotation chain. This
 * module owns every read and write of that table:
 *   - issuance (login and refresh) upserts the row for the minted `sid`;
 *   - session deletion and password change set `revokedAt`;
 *   - central auth rejects any token whose `sid` carries a `revokedAt`.
 */

type AuthSessionStore = Pick<Prisma.TransactionClient, 'authSession'>

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/**
 * Record that a login session exists. Idempotent on `sid` because a refresh
 * rotation mints a new access token under the SAME sid: on conflict the row
 * is left alone except for `lastSeenAt`/`userAgent` refreshes. It never
 * clears `revokedAt` — a rotation must not un-revoke a deleted session.
 */
export const recordAuthSession = async (
  tx: AuthSessionStore,
  input: { sessionId: string; userAgent?: string | null; userId: string },
): Promise<void> => {
  if (!isUuid(input.sessionId)) return
  await tx.authSession.upsert({
    where: { id: input.sessionId },
    create: {
      id: input.sessionId,
      userId: input.userId,
      userAgent: input.userAgent ?? null,
    },
    update: {
      lastSeenAt: new Date(),
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    },
  })
}

/**
 * True only when an explicit revoked row exists.
 *
 * Deliberate rollout-safety tradeoff: a `sid` with NO AuthSession row is
 * ACCEPTED (fail-open on absence, fail-closed only on an explicit revocation).
 * Tokens minted before this table existed, and any issuance path not yet
 * writing rows, must keep authenticating until issuance is proven to cover
 * every path; the check tightens to fail-closed once that proof lands.
 */
export const isAuthSessionRevoked = async (
  prisma: Pick<PrismaClient, 'authSession'>,
  sessionId: string,
): Promise<boolean> => {
  if (!isUuid(sessionId)) return false
  const row = await prisma.authSession.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true },
  })
  return row?.revokedAt != null
}

export const DEFAULT_REVOCATION_CACHE_TTL_MS = 30_000

/**
 * One indexed lookup per authenticated request, memoised per process for a
 * short TTL. Honest staleness bound: each API replica keeps its own cache, so
 * after a session is revoked, a replica that served that sid shortly before
 * the revoke keeps accepting its access tokens for up to `ttlMs`. Workstream
 * 1's pg-NOTIFY push invalidation replaces this TTL-only bound later.
 */
export const createAuthSessionRevocationChecker = (
  prisma: Pick<PrismaClient, 'authSession'>,
  ttlMs = DEFAULT_REVOCATION_CACHE_TTL_MS,
): ((sessionId: string) => Promise<boolean>) => {
  const cache = new Map<string, { expiresAt: number; revoked: boolean }>()
  return async (sessionId) => {
    const now = Date.now()
    const cached = cache.get(sessionId)
    if (cached && cached.expiresAt > now) {
      return cached.revoked
    }
    const revoked = await isAuthSessionRevoked(prisma, sessionId)
    cache.set(sessionId, { expiresAt: now + ttlMs, revoked })
    return revoked
  }
}

/**
 * Mark one login session revoked. `updateMany` (not `update`) so deleting a
 * session whose row is missing — a pre-registry session — is a no-op rather
 * than an error; the refresh-family revocation beside it is the 404 signal.
 */
export const revokeAuthSessionRow = (
  tx: AuthSessionStore,
  input: { sessionId: string; userId: string },
): Promise<Prisma.BatchPayload> => tx.authSession.updateMany({
  where: { id: input.sessionId, userId: input.userId, revokedAt: null },
  data: { revokedAt: new Date() },
})

/** Mark every login session of the user revoked, optionally sparing one. */
export const revokeAuthSessionRows = (
  tx: AuthSessionStore,
  input: { exceptSessionId?: string | null; userId: string },
): Promise<Prisma.BatchPayload> => tx.authSession.updateMany({
  where: {
    userId: input.userId,
    revokedAt: null,
    ...(input.exceptSessionId ? { id: { not: input.exceptSessionId } } : {}),
  },
  data: { revokedAt: new Date() },
})
