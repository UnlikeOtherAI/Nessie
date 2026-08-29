import crypto from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * One-shot authorization state for the MCP OAuth handshake.
 *
 * Split out of `mcp-oauth.ts` because persisting a short-lived correlation
 * token is its own responsibility: `startOAuth` writes it, the API callback
 * (possibly in another process) reads it exactly once, and neither needs to
 * know how the other half of the flow works.
 */

/**
 * Carries everything the callback needs so the dynamic flow never has to
 * re-discover metadata (which could have changed between start and callback —
 * TOCTOU on the token endpoint).
 */
export type OAuthStateRecord = {
  instanceId: string
  organizationId: string
  actorId: string
  /** epoch ms when this state token expires */
  expiresAt: number
  mode: 'static' | 'dynamic'
  redirectUri: string
  /**
   * PKCE verifier. Written in BOTH modes — an authorization-code flow without
   * proof of possession is a defect, and the callback must send back exactly
   * the verifier whose challenge was authorized (RFC 7636 §4.6).
   */
  codeVerifier?: string
  /** Client + endpoints resolved at start time (dynamic mode). */
  clientId?: string
  clientSecretRef?: string
  tokenEndpoint?: string
  /** RFC 8707 resource indicator the token is bound to (both modes). */
  resource?: string
}

export type OAuthStateStore = {
  put: (token: string, record: OAuthStateRecord) => Promise<void>
  take: (token: string) => Promise<OAuthStateRecord | null>
}

/** In-memory state store for unit tests / single-process fallbacks. */
export const createInMemoryStateStore = (): OAuthStateStore => {
  const map = new Map<string, OAuthStateRecord>()

  const purgeExpired = (now: number): void => {
    for (const [token, record] of map.entries()) {
      if (record.expiresAt <= now) {
        map.delete(token)
      }
    }
  }

  return {
    put: async (token, record) => {
      purgeExpired(Date.now())
      map.set(token, record)
    },
    take: async (token) => {
      const now = Date.now()
      purgeExpired(now)
      const record = map.get(token)
      if (!record) return null
      // Tokens are one-shot — delete on read regardless of expiry verdict.
      map.delete(token)
      if (record.expiresAt <= now) return null
      return record
    },
  }
}

/**
 * Postgres-backed state store (`mcp_oauth_states`) — the production default.
 * Works across processes: the worker's personal assistant can mint a flow the
 * API's callback completes. Rows are deleted on first read (one-shot) and
 * expired rows are purged opportunistically on every write.
 */
export const createPgOAuthStateStore = (prisma: PrismaClient): OAuthStateStore => ({
  put: async (token, record) => {
    await prisma.mcpOAuthState.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    })
    const { expiresAt, ...payload } = record
    await prisma.mcpOAuthState.create({
      data: {
        token,
        payload: payload as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(expiresAt),
      },
    })
  },
  take: async (token) => {
    let row: { payload: unknown; expiresAt: Date }
    try {
      row = await prisma.mcpOAuthState.delete({ where: { token } })
    } catch {
      return null
    }
    if (row.expiresAt.getTime() <= Date.now()) return null
    const payload = row.payload as Omit<OAuthStateRecord, 'expiresAt'>
    return { ...payload, expiresAt: row.expiresAt.getTime() }
  },
})

/**
 * Per-process singleton in-memory store, kept as the zero-config default for
 * tests. Routes and the worker wire `createPgOAuthStateStore` explicitly.
 */
export const defaultOAuthStateStore = createInMemoryStateStore()

/** 10 minutes per task #20 spec. */
export const STATE_TTL_MS = 10 * 60 * 1000

/**
 * Mint a cryptographically random `state` parameter. `base64url` keeps the
 * token URL-safe so providers don't mangle it in redirects.
 */
export const generateState = (): string =>
  crypto.randomBytes(32).toString('base64url')
