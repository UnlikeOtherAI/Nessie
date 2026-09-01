/**
 * Secret resolver boundary for the MCP universal connector.
 *
 * Per plan `docs/plans/2026-05-16-mcp-universal-connector.md` D7 and
 * `docs/secret-management-spec.md`, credentials are stored in the DB only as
 * opaque `credentialRef` strings. The actual plaintext lookup happens behind
 * this interface so the service layer never sees raw secret material.
 *
 * User-authored credentials are always opaque `secret_*` references resolved
 * by the encrypted Postgres store. Environment-backed references are reserved
 * for the exact first-party integration credentials provisioned internally.
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
 * Resolve only the exact deployment credentials owned by first-party
 * integration provisioning. This is deliberately not a general environment
 * lookup: a caller-supplied ref can never select an arbitrary process secret.
 * User-authored and OAuth credentials resolve from the encrypted Postgres
 * store in the layered production resolver.
 */
export const MCP_OPERATOR_ENV_SECRET_REFS = [
  'DEEPSIGNAL_MCP_APP_KEY',
  'LEDGER_PROXY_TOKEN',
] as const

const operatorEnvSecretRefs = new Set<string>(MCP_OPERATOR_ENV_SECRET_REFS)

export const isOperatorEnvSecretRef = (ref: string): boolean =>
  operatorEnvSecretRefs.has(ref)

export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string | null> {
    if (!isOperatorEnvSecretRef(ref)) return null
    const value = this.env[ref]
    return typeof value === 'string' && value.length > 0 ? value : null
  }
}

/**
 * Try each resolver in order; first non-null answer wins. Used to compose the
 * encrypted Postgres store (`secret_*` refs minted by OAuth handshakes and
 * assistant-collected credentials) with the exact internal env allowlist.
 */
export const createLayeredSecretResolver = (
  resolvers: SecretResolver[],
): SecretResolver => ({
  resolve: async (ref: string): Promise<string | null> => {
    for (const resolver of resolvers) {
      const value = await resolver.resolve(ref)
      if (value !== null) return value
    }
    return null
  },
})
