import crypto from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '@nessie/runtime'

/**
 * Encrypted store for raw push-credential secret bytes (the APNs `.p8` key
 * contents, the FCM service-account JSON). Reuses the AES-256-GCM scheme and
 * the `mcp_oauth_secret` table from the OAuth SecretStore, keyed off the
 * deployment's auth secret. Entries carry a `secret_push_` ref prefix so they
 * never collide with `secret_oauth_` entries.
 *
 * Unlike the OAuth store (write-only `put`), push credentials must be re-read
 * server-side to re-mint the APNs JWT / re-run the FCM token exchange during a
 * `test`. The plaintext is therefore resolvable here, but it is NEVER returned
 * from any HTTP endpoint — only the validation/test code reads it.
 */
export type PushSecretStore = {
  /** Persist plaintext secret bytes; returns a stable `secret_push_*` ref. */
  put: (plaintext: string) => Promise<string>
  /** Resolve a ref to its plaintext, or null if unknown. */
  resolve: (ref: string) => Promise<string | null>
  /** Delete a stored secret by ref (no-op if absent). */
  remove: (ref: string) => Promise<void>
}

const PUSH_REF_PREFIX = 'secret_push_'

export const createPushSecretStore = (
  prisma: PrismaClient,
  encryptionSecret: string,
): PushSecretStore => {
  const key = deriveSecretKey(encryptionSecret)
  return {
    put: async (plaintext) => {
      const ref = `${PUSH_REF_PREFIX}${crypto.randomBytes(16).toString('hex')}`
      const { ciphertext, iv, authTag } = encryptWithKey(key, plaintext)
      await prisma.mcpOAuthSecret.create({
        data: { ref, ciphertext, iv, authTag },
      })
      return ref
    },
    resolve: async (ref) => {
      if (!ref.startsWith(PUSH_REF_PREFIX)) {
        return null
      }
      const row = await prisma.mcpOAuthSecret.findUnique({ where: { ref } })
      if (!row) {
        return null
      }
      return decryptWithKey(key, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
      })
    },
    remove: async (ref) => {
      if (!ref.startsWith(PUSH_REF_PREFIX)) {
        return
      }
      await prisma.mcpOAuthSecret.deleteMany({ where: { ref } })
    },
  }
}
