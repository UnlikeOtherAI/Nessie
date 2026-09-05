import crypto from 'node:crypto'

/**
 * Credential-at-rest helpers for communications connections.
 *
 * The packing itself moved to `@nessie/runtime` (`sealed-secret.ts`) when board
 * sources needed the same thing: a second connector package importing this one
 * for a cryptographic helper would have made comms a dependency of everything
 * that stores a token. Re-exported here so this package's own callers are
 * unchanged and there is still exactly one implementation.
 */
export { openSecret, sealSecret } from '@nessie/runtime'

/**
 * A stable hash of a granted-scope set, order-independent. Persisted as
 * `CommsConnectionCredential.scopeHash` so a re-auth can detect that the scope
 * grant changed without decrypting the token bundle.
 */
export const computeScopeHash = (scopes: readonly string[]): string => {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))]
    .filter((scope) => scope.length > 0)
    .sort()
    .join(' ')
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}
