import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '../lib/secret-crypto.js'

import type { SecretStore } from './mcp-oauth.js'

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
): SecretStore => {
  const key = deriveSecretKey(encryptionSecret)
  return {
    put: async (input) => {
      const ref = `secret_oauth_${crypto.randomBytes(16).toString('hex')}`
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
 * Read side of {@link createPgSecretStore}. Resolves a `secret_oauth_*` ref to
 * the plaintext access token (the value the dispatcher injects into the MCP
 * transport). Returns `null` for unknown refs so callers can fall through to
 * other resolvers.
 */
export const createPgSecretResolver = (
  prisma: PrismaClient,
  encryptionSecret: string,
): { resolve: (ref: string) => Promise<string | null> } => {
  const key = deriveSecretKey(encryptionSecret)
  return {
    resolve: async (ref) => {
      if (!ref.startsWith('secret_oauth_')) {
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
