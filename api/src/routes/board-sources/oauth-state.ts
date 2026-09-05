import { createHash, randomBytes } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { BoardSourceProvider } from '@nessie/schemas'

/**
 * Single-use, TTL-bound OAuth state for a board-source connection, backed by
 * Postgres rather than memory so a callback that lands on a different API
 * instance still resolves — the same shape `mcp_oauth_states` uses.
 */

const STATE_TTL_MS = 10 * 60 * 1000

export type BoardSourceOAuthStatePayload = {
  codeVerifier?: string
  /** Set when re-authorizing: the connection this must come back as. */
  targetConnectionId?: string
  /** The account the re-authorization must prove, so it cannot silently re-point. */
  expectedAccountId?: string
  /** Where the callback page sends the person on a full-page redirect. */
  returnPath?: string
}

export const createOAuthState = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    provider: BoardSourceProvider
    payload: BoardSourceOAuthStatePayload
  },
): Promise<string> => {
  const token = randomBytes(32).toString('base64url')
  await prisma.boardSourceOAuthState.create({
    data: {
      token,
      organizationId: input.organizationId,
      userId: input.userId,
      provider: input.provider,
      payload: input.payload,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  })
  return token
}

/**
 * Consume a state exactly once.
 *
 * The conditional delete is the claim: it returns the row it removed, so a
 * replayed callback finds nothing and is refused. Doing it as read-then-delete
 * would leave a window in which two concurrent callbacks both read a live state
 * and both redeem the code.
 */
export const consumeOAuthState = async (
  prisma: PrismaClient,
  token: string,
): Promise<{
  organizationId: string
  userId: string
  provider: BoardSourceProvider
  payload: BoardSourceOAuthStatePayload
} | null> => {
  const rows = await prisma.$queryRaw<
    {
      organization_id: string
      user_id: string
      provider: BoardSourceProvider
      payload: BoardSourceOAuthStatePayload
    }[]
  >`
    DELETE FROM "board_source_oauth_states"
     WHERE "token" = ${token} AND "expires_at" > now()
    RETURNING "organization_id", "user_id", "provider", "payload"
  `
  const row = rows[0]
  if (!row) return null
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    provider: row.provider,
    payload: row.payload,
  }
}

/** PKCE S256, for the providers that support it. */
export const createPkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
