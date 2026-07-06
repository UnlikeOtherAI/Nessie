import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '@nessie/runtime'

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
 * Token material is only ever written encrypted; the plaintext never leaves
 * this module except through {@link createPgSecretResolver}, which the secret
 * resolver boundary uses to hand a single credential back to the dispatcher.
 */

type StoredBundle = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  tokenType?: string
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
      }
      const { ciphertext, iv, authTag } = encryptWithKey(key, JSON.stringify(bundle))
      await prisma.mcpOAuthSecret.create({
        data: { ref, ciphertext, iv, authTag },
      })
      return ref
    },
  }
}

/**
 * Read side of {@link createPgSecretStore}. Resolves a `secret_*` ref to the
 * plaintext access token (the value the dispatcher injects into the MCP
 * transport). Returns `null` for unknown refs so callers can fall through to
 * other resolvers.
 */
export const createPgSecretResolver = (
  prisma: PrismaClient,
  encryptionSecret: string,
): SecretResolver => {
  const key = deriveSecretKey(encryptionSecret)
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
      return bundle.accessToken
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
