/**
 * Secret resolver boundary for the MCP universal connector.
 *
 * Per plan `docs/plans/2026-05-16-mcp-universal-connector.md` D7 and
 * `docs/secret-management-spec.md`, credentials are stored in the DB only as
 * opaque `credentialRef` strings. The actual plaintext lookup happens behind
 * this interface so the service layer never sees raw secret material.
 *
 * The current Phase-3 KMS-backed implementation is out of scope for this
 * slice. We ship a `NullSecretResolver` for use in tests and a stub
 * `EnvSecretResolver` so the worker dispatcher has something to call while the
 * real resolver is being built.
 */
export type SecretResolver = {
  resolve(ref: string): Promise<string | null>
}

/**
 * Resolver that returns `null` for every ref. Useful in unit tests where the
 * caller only needs to verify that resolution was attempted.
 */
export class NullSecretResolver implements SecretResolver {
  async resolve(_ref: string): Promise<string | null> {
    return null
  }
}

/**
 * Stub resolver that looks the ref up as an environment variable name. This is
 * NOT the production resolver — the real implementation will hit the secret
 * manager described in `docs/secret-management-spec.md`. We keep this thin
 * fallback so the dispatcher can be wired end-to-end in local dev until the
 * KMS-backed resolver lands.
 *
 * TODO(phase3): replace with the real KMS-backed resolver from
 * `packages/runtime` once it ships.
 */
export class EnvSecretResolver implements SecretResolver {
  async resolve(ref: string): Promise<string | null> {
    if (!ref) return null
    const value = process.env[ref]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
}
