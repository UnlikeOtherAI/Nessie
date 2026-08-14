import {
  isSessionTokenRevoked,
  verifySessionToken,
  type SessionTokenClaims,
} from '../auth/session.js'
import { sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

// Workspace-switch recovery refusal helpers. Each preserves the exact response
// the login route sent inline; keep the codes and messages byte-identical.
export const rejectWorkspaceTarget = (
  reply: Parameters<typeof sendApiError>[0],
): void => {
  sendApiError(
    reply,
    401,
    'WORKSPACE_TARGET_MISMATCH',
    'The renewed session is not on the requested workspace. Try switching again.',
  )
}

export const rejectWorkspaceIdentity = (
  reply: Parameters<typeof sendApiError>[0],
): void => {
  sendApiError(
    reply,
    401,
    'WORKSPACE_IDENTITY_MISMATCH',
    'This sign-in belongs to a different account. Try switching again.',
  )
}

export const rejectWorkspaceRecovery = rejectWorkspaceIdentity

// Verify the Bearer Nessie session an expectedWorkspace discriminant must
// accompany: a live, unrevoked UOA access token for an existing local user
// with an immutable UOA identity bound. Returns null on any refusal — every
// caller rejects before any upstream exchange or local write.
export const verifyRecoveryBearer = async (
  request: Parameters<RouteDeps['getAuthorizationToken']>[0],
  deps: Pick<RouteDeps, 'authSecret' | 'getAuthorizationToken' | 'prisma'>,
): Promise<SessionTokenClaims | null> => {
  const { authSecret, getAuthorizationToken, prisma } = deps
  const bearer = getAuthorizationToken(request)
  if (!bearer) {
    return null
  }
  const verification = verifySessionToken(bearer, authSecret)
  if (!verification.ok) {
    return null
  }
  if (verification.claims.providerId !== 'uoa') {
    return null
  }
  // An account-bound recovery requires a finite, non-negative bearer UOA
  // credential epoch — matching the strict refresh/switch guard — so a
  // bearer whose UOA identity carries no (or an invalid/negative) epoch
  // fails closed before any upstream exchange. This claim-shape check runs
  // BEFORE the user-row read below so a malformed bearer leaves zero
  // database traffic, like every other bearer refusal.
  if (
    verification.claims.providerType !== 'uoa'
    || !verification.claims.uoaIdentity
    || verification.claims.uoaIdentity.tokenVersion === null
    || !Number.isSafeInteger(verification.claims.uoaIdentity.tokenVersion)
    || verification.claims.uoaIdentity.tokenVersion < 0
  ) {
    return null
  }
  const sessionUser = await prisma.user.findUnique({
    where: { id: verification.claims.sub },
    select: { tokenVersion: true },
  })
  if (!sessionUser || isSessionTokenRevoked(verification.claims, sessionUser.tokenVersion)) {
    return null
  }
  return verification.claims
}
