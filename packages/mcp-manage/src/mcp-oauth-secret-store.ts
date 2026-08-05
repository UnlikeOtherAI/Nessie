import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
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
 * Postgres, encrypted at rest with AES-256-GCM under a key derived from the
 * deployment's auth secret, so completing an OAuth handshake durably stores the
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

/**
 * Build a Postgres-backed, encrypted {@link SecretStore}. Inject the result as
 * `oauthSecretStore` into `registerMcpRoutes`.
 */
export const createPgSecretStore = (
  prisma: PrismaClient,
  encryptionSecret: string,
  options: {
    /**
     * Ref prefix for minted secrets. Must start with `secret_` so refs stay
     * recognisable to the resolver chain. OAuth handshakes use the default;
     * assistant-collected credentials use `secret_mcp_`.
     */
    refPrefix?: string
  } = {},
): SecretStore => {
  const refPrefix = options.refPrefix ?? 'secret_oauth_'
  if (!refPrefix.startsWith('secret_')) {
    throw new Error(`Secret ref prefix must start with "secret_", got "${refPrefix}"`)
  }
  const key = deriveSecretKey(encryptionSecret)
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
      const { ciphertext, iv, authTag } = encryptWithKey(key, JSON.stringify(bundle))
      await prisma.mcpOAuthSecret.create({
        data: { ref, ciphertext, iv, authTag },
      })
      return ref
    },
  }
}

/** Refresh when the token is within this window of expiry (or already past). */
const REFRESH_SKEW_MS = 60_000

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

/**
 * Read side of {@link createPgSecretStore}. Resolves a `secret_*` ref to the
 * plaintext access token (the value the dispatcher injects into the MCP
 * transport), refreshing it first when it has expired and the bundle carries
 * refresh metadata. Returns `null` for unknown refs so callers can fall
 * through to other resolvers.
 */
export const createPgSecretResolver = (
  prisma: PrismaClient,
  encryptionSecret: string,
  options: { fetchImpl?: typeof fetch } = {},
): SecretResolver => {
  const key = deriveSecretKey(encryptionSecret)
  const fetchImpl = options.fetchImpl ?? pinnedMcpFetch
  return {
    resolve: async (ref) => {
      if (!ref.startsWith('secret_')) {
        return null
      }
      const row = await prisma.mcpOAuthSecret.findUnique({ where: { ref } })
      if (!row) {
        return null
      }
      const bundle = JSON.parse(
        decryptWithKey(key, {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
        }),
      ) as StoredBundle

      if (!shouldRefresh(bundle)) {
        return bundle.accessToken
      }

      const renewed = await refreshBundle(bundle, fetchImpl)
      if (!renewed) {
        // Best-effort: hand back the stale token so the server's 401 surfaces
        // loudly instead of a silent resolver failure.
        return bundle.accessToken
      }
      const { ciphertext, iv, authTag } = encryptWithKey(key, JSON.stringify(renewed))
      await prisma.mcpOAuthSecret
        .update({ where: { ref }, data: { ciphertext, iv, authTag } })
        .catch(() => undefined)
      return renewed.accessToken
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
  encryptionSecret: string,
): SecretResolver =>
  createLayeredSecretResolver([
    createPgSecretResolver(prisma, encryptionSecret),
    new EnvSecretResolver(),
  ])
