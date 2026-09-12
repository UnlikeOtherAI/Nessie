import crypto from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'

import {
  decryptWithKeyRing,
  encryptWithKeyRing,
  toEncryptionKeyRing,
  AT_REST_SECRET_PURPOSE,
  type EncryptionKeyRingInput,
} from '@nessie/runtime'

import { assertMcpUrlSafe, pinnedMcpFetch } from './mcp-security.js'
import type { SecretStore } from './mcp-oauth.js'
import {
  createLayeredSecretResolver,
  EnvSecretResolver,
  type SecretResolver,
} from './secret-resolver.js'

/**
 * Persistent, encrypted implementation of the MCP OAuth {@link SecretStore}.
 *
 * The in-memory stub (`inMemorySecretStoreStub`) only mints opaque refs and
 * drops the token material, which is why `registerMcpRoutes` refuses to boot
 * with it under `NODE_ENV=production`. This store persists the token bundle in
 * Postgres, encrypted at rest with AES-256-GCM under a versioned, purpose-bound
 * deployment key ring, so completing an OAuth handshake durably stores the
 * credentials instead of silently losing them.
 *
 * **Automatic refresh:** OAuth bundles carry their refresh metadata
 * (refresh_token + token endpoint + client). When the resolver finds an
 * expired (or nearly expired) access token it renews it in place with a
 * `refresh_token` grant and re-encrypts the bundle — dispatch and probe paths
 * get a live token without ever seeing the refresh mechanics.
 *
 * Token material is only ever written encrypted; the plaintext never leaves
 * this module except through {@link createPgSecretResolver}, which the secret
 * resolver boundary uses to hand a single credential back to the dispatcher.
 */

type StoredBundle = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
  /** epoch ms when the access token expires (derived from expiresIn at write). */
  expiresAt?: number
  /** Refresh metadata (dynamic OAuth flows). */
  tokenEndpoint?: string
  clientId?: string
  clientSecret?: string
  resource?: string
}

type StoredSecretRow = {
  authTag: string
  ciphertext: string
  iv: string
  ref: string
}

const MCP_SECRET_LOCK_TIMEOUT_MS = 15_000

/**
 * Serializes one durable MCP secret across API and worker replicas. The lock is
 * held while a provider can rotate the refresh token, so a maintenance
 * re-encryption cannot win the ciphertext CAS and discard that new credential.
 */
export const withMcpOAuthSecretLock = async <T>(
  prisma: PrismaClient,
  ref: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => prisma.$transaction(async (tx) => {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-oauth-secret:${ref}`}, 0))`,
  )
  return work(tx)
}, { timeout: MCP_SECRET_LOCK_TIMEOUT_MS })

/**
 * Build a Postgres-backed, encrypted {@link SecretStore}. Inject the result as
 * `oauthSecretStore` into `registerMcpRoutes`.
 */
export const createPgSecretStore = (
  prisma: PrismaClient | Prisma.TransactionClient,
  encryption: EncryptionKeyRingInput,
  options: {
    /**
     * Ref prefix for minted secrets. Must start with `secret_` so refs stay
     * recognisable to the resolver chain. OAuth handshakes use the default;
     * assistant-collected credentials use `secret_mcp_`.
     */
    refPrefix?: string
    /** Stable at-rest domain for this opaque-reference family. */
    purpose?: string
  } = {},
): SecretStore => {
  const refPrefix = options.refPrefix ?? 'secret_oauth_'
  if (!refPrefix.startsWith('secret_')) {
    throw new Error(`Secret ref prefix must start with "secret_", got "${refPrefix}"`)
  }
  const purpose = options.purpose ?? (
    refPrefix === 'secret_mcp_'
      ? AT_REST_SECRET_PURPOSE.mcpCredential
      : AT_REST_SECRET_PURPOSE.mcpOauth
  )
  const keyRing = toEncryptionKeyRing(encryption)
  return {
    put: async (input) => {
      const ref = `${refPrefix}${crypto.randomBytes(16).toString('hex')}`
      const bundle: StoredBundle = {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresIn: input.expiresIn,
        tokenType: input.tokenType,
        expiresAt:
          typeof input.expiresIn === 'number'
            ? Date.now() + input.expiresIn * 1000
            : undefined,
        tokenEndpoint: input.tokenEndpoint,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        resource: input.resource,
      }
      const { ciphertext, iv, authTag } = encryptWithKeyRing(
        keyRing,
        purpose,
        JSON.stringify(bundle),
      )
      await prisma.mcpOAuthSecret.create({
        data: { ref, ciphertext, iv, authTag },
      })
      return ref
    },
  }
}

/** Refresh when the token is within this window of expiry (or already past). */
const REFRESH_SKEW_MS = 60_000

const purposeForStoredRef = (ref: string): string => {
  if (ref.startsWith('secret_oauth_')) return AT_REST_SECRET_PURPOSE.mcpOauth
  if (ref.startsWith('secret_mcp_')) return AT_REST_SECRET_PURPOSE.mcpCredential
  if (ref.startsWith('secret_browserbase_')) return AT_REST_SECRET_PURPOSE.browserConnection
  if (ref.startsWith('secret_dashboard_')) return AT_REST_SECRET_PURPOSE.dashboardCredential
  throw new Error('[mcp-secret-store] unrecognised persistent secret reference.')
}

const shouldRefresh = (bundle: StoredBundle): boolean =>
  typeof bundle.expiresAt === 'number'
  && Date.now() >= bundle.expiresAt - REFRESH_SKEW_MS
  && typeof bundle.refreshToken === 'string'
  && bundle.refreshToken.length > 0
  && typeof bundle.tokenEndpoint === 'string'
  && bundle.tokenEndpoint.length > 0
  && typeof bundle.clientId === 'string'
  && bundle.clientId.length > 0

/**
 * RFC 6749 §6 refresh_token grant. Returns the renewed bundle, or null when
 * the provider refuses (revoked grant, rotated refresh token, …) — in that
 * case the stale access token is returned to the caller so the downstream
 * 401 stays visible instead of being masked by a resolver error.
 */
const refreshBundle = async (
  bundle: StoredBundle,
  fetchImpl: typeof fetch,
): Promise<StoredBundle | null> => {
  try {
    await assertMcpUrlSafe(bundle.tokenEndpoint as string)
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken as string,
      client_id: bundle.clientId as string,
    })
    if (bundle.clientSecret) body.set('client_secret', bundle.clientSecret)
    if (bundle.resource) body.set('resource', bundle.resource)
    const response = await fetchImpl(bundle.tokenEndpoint as string, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    const payload = (await response.json()) as Record<string, unknown>
    const accessToken = payload['access_token']
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null
    const refreshToken = payload['refresh_token']
    const expiresIn = payload['expires_in']
    return {
      ...bundle,
      accessToken,
      // Providers with rotation return a new refresh token; keep the old one
      // otherwise.
      refreshToken:
        typeof refreshToken === 'string' && refreshToken.length > 0
          ? refreshToken
          : bundle.refreshToken,
      expiresIn: typeof expiresIn === 'number' ? expiresIn : bundle.expiresIn,
      expiresAt:
        typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : undefined,
    }
  } catch {
    return null
  }
}

const sameBundle = (left: StoredBundle, right: StoredBundle): boolean =>
  left.accessToken === right.accessToken
  && left.clientId === right.clientId
  && left.clientSecret === right.clientSecret
  && left.expiresAt === right.expiresAt
  && left.expiresIn === right.expiresIn
  && left.refreshToken === right.refreshToken
  && left.resource === right.resource
  && left.tokenEndpoint === right.tokenEndpoint
  && left.tokenType === right.tokenType

const loadBundle = (
  keyRing: ReturnType<typeof toEncryptionKeyRing>,
  purpose: string,
  row: StoredSecretRow,
) => {
  const opened = decryptWithKeyRing(keyRing, purpose, {
    authTag: row.authTag,
    ciphertext: row.ciphertext,
    iv: row.iv,
  })
  return { bundle: JSON.parse(opened.plaintext) as StoredBundle, opened }
}

const replaceCurrentBundle = async (
  tx: Prisma.TransactionClient,
  row: StoredSecretRow,
  data: { authTag: string; ciphertext: string; iv: string },
): Promise<boolean> => {
  const update = await tx.mcpOAuthSecret.updateMany({
    where: {
      ref: row.ref,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
    },
    data,
  })
  return update.count === 1
}

/**
 * Read side of {@link createPgSecretStore}. Resolves a `secret_*` ref to the
 * plaintext access token (the value the dispatcher injects into the MCP
 * transport), refreshing it first when it has expired and the bundle carries
 * refresh metadata. Returns `null` for unknown refs so callers can fall
 * through to other resolvers.
 */
export const createPgSecretResolver = (
  prisma: PrismaClient,
  encryption: EncryptionKeyRingInput,
  options: { fetchImpl?: typeof fetch } = {},
): SecretResolver => {
  const keyRing = toEncryptionKeyRing(encryption)
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  return {
    resolve: async (ref) => {
      if (!ref.startsWith('secret_')) return null
      let purpose: string
      try {
        purpose = purposeForStoredRef(ref)
      } catch {
        return null
      }
      return withMcpOAuthSecretLock(prisma, ref, async (tx) => {
        const row = await tx.mcpOAuthSecret.findUnique({ where: { ref } })
        if (!row) return null
        const { bundle, opened } = loadBundle(keyRing, purpose, row)

        if (!shouldRefresh(bundle)) {
          if (opened.needsReencryption) {
            const replacement = encryptWithKeyRing(keyRing, purpose, JSON.stringify(bundle))
            await replaceCurrentBundle(tx, row, replacement).catch(() => false)
          }
          return bundle.accessToken
        }

        const renewed = await refreshBundle(bundle, fetchImpl)
        if (!renewed) {
          // The provider refused the grant. Preserve its currently stored
          // refresh token, but still migrate its authenticated ciphertext.
          if (opened.needsReencryption) {
            const replacement = encryptWithKeyRing(keyRing, purpose, JSON.stringify(bundle))
            await replaceCurrentBundle(tx, row, replacement).catch(() => false)
          }
          return bundle.accessToken
        }

        const replacement = encryptWithKeyRing(keyRing, purpose, JSON.stringify(renewed))
        if (await replaceCurrentBundle(tx, row, replacement).catch(() => false)) {
          return renewed.accessToken
        }

        // A non-participating writer can still beat the conditional update.
        // If it merely re-encrypted the exact bundle, retry against its current
        // envelope so a provider-issued rotating refresh token is not dropped.
        const current = await tx.mcpOAuthSecret.findUnique({ where: { ref } })
        if (!current) return null
        const latest = loadBundle(keyRing, purpose, current)
        if (sameBundle(latest.bundle, bundle)) {
          if (await replaceCurrentBundle(tx, current, replacement).catch(() => false)) {
            return renewed.accessToken
          }
          const afterRetry = await tx.mcpOAuthSecret.findUnique({ where: { ref } })
          if (!afterRetry) return null
          return loadBundle(keyRing, purpose, afterRetry).bundle.accessToken
        }

        // A logical credential update wins over this refresh. Do not overwrite
        // a newer provider token with material minted for the old credential.
        return latest.bundle.accessToken
      })
    },
  }
}

/**
 * The standard resolver chain for MCP credentials: encrypted Postgres store
 * first (OAuth tokens + assistant-collected secrets), then the env-var
 * convention for operator-provisioned refs. Wire this into probe routes and
 * the worker's MCP toolset so both resolve the same refs the same way.
 */
export const createMcpSecretResolver = (
  prisma: PrismaClient,
  encryption: EncryptionKeyRingInput,
): SecretResolver =>
  createLayeredSecretResolver([
    createPgSecretResolver(prisma, encryption),
    new EnvSecretResolver(),
  ])
