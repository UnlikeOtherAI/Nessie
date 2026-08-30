import {
  OAuthClientConfigError,
  buildClientIdMetadataDocumentUrl,
  findOperatorOAuthClient,
  type OAuthClientResolutionConfig,
  type OperatorOAuthClient,
} from '@nessie/mcp-manage'

/**
 * Which OAuth client identity *this deployment* can present, assembled once at
 * the API composition root.
 *
 * `resolveOAuthClientStrategy` (`@nessie/mcp-manage`) owns the preference order
 * — pre-registered → client-ID metadata document → dynamic registration →
 * operator-supplied. It cannot own the deployment facts those tiers need, so
 * without this module every caller hands it an empty config and the CIMD and
 * operator tiers are unreachable no matter what an authorization server
 * advertises.
 *
 * Both inputs are operator statements read from process env, never from a
 * request: a client identity steered by a Host header is a client identity an
 * attacker chose.
 */

/**
 * Operator-named OAuth clients, keyed by authorization-server issuer. JSON so
 * one variable can carry several servers:
 *
 * ```
 * NESSIE_MCP_OAUTH_CLIENTS='[{"issuer":"https://auth.acme.example",
 *                             "clientId":"nessie","clientSecret":"…"}]'
 * ```
 */
export const OPERATOR_OAUTH_CLIENTS_ENV = 'NESSIE_MCP_OAUTH_CLIENTS'

const ENTRY_KEYS = new Set(['issuer', 'clientId', 'clientSecret'])

/**
 * Messages name the variable, the entry index, and the field — never a value.
 * An operator who pastes a client secret into the wrong field would otherwise
 * see it echoed into the boot log of every replica.
 */
const configError = (detail: string): OAuthClientConfigError =>
  new OAuthClientConfigError(`${OPERATOR_OAUTH_CLIENTS_ENV}: ${detail}`)

const requireNonEmptyString = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw configError(`${where} must be a non-empty string`)
  }
  return value.trim()
}

const requireIssuerUrl = (value: unknown, where: string): string => {
  const issuer = requireNonEmptyString(value, where)
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw configError(`${where} must be an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw configError(`${where} must be an http(s) URL`)
  }
  return issuer
}

const parseEntry = (
  raw: unknown,
  index: number,
  accepted: readonly OperatorOAuthClient[],
): OperatorOAuthClient => {
  const where = `entry ${index}`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw configError(`${where} must be an object with issuer, clientId and an optional clientSecret`)
  }
  const entry = raw as Record<string, unknown>
  for (const key of Object.keys(entry)) {
    // A typo (`client_id`) would otherwise produce a client with no id, or one
    // silently missing its secret — a broken flow discovered at an authorize
    // screen instead of at boot.
    if (!ENTRY_KEYS.has(key)) throw configError(`${where} has unknown field "${key}"`)
  }
  const issuer = requireIssuerUrl(entry.issuer, `${where}.issuer`)
  // Ask the resolver's own issuer comparison, so "already covered" here means
  // exactly what "matches this authorization server" means at dispatch: two
  // entries the resolver cannot tell apart are ambiguous, and silently keeping
  // the first would send one server's credentials on behalf of another.
  if (findOperatorOAuthClient(accepted, issuer)) {
    throw configError(`${where}.issuer duplicates an earlier entry`)
  }
  const clientId = requireNonEmptyString(entry.clientId, `${where}.clientId`)
  if (entry.clientSecret === undefined) return { issuer, clientId }
  return {
    issuer,
    clientId,
    clientSecret: requireNonEmptyString(entry.clientSecret, `${where}.clientSecret`),
  }
}

/**
 * Parse `NESSIE_MCP_OAUTH_CLIENTS`. Unset or empty means the deployment named
 * no clients; anything malformed throws, because an entry that silently never
 * applies looks identical to one that works until a person reaches the
 * provider's sign-in page.
 */
export const parseOperatorOAuthClients = (
  raw: string | undefined,
): readonly OperatorOAuthClient[] => {
  const trimmed = raw?.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw configError('must be valid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw configError('must be a JSON array of {issuer, clientId, clientSecret?} objects')
  }
  const clients: OperatorOAuthClient[] = []
  for (const [index, entry] of parsed.entries()) {
    clients.push(parseEntry(entry, index, clients))
  }
  return clients
}

export type OAuthClientResolutionInput = {
  /**
   * The operator-declared public origin of this API (`NESSIE_API_PUBLIC_URL`,
   * surfaced as `config.api.publicUrl`).
   */
  apiPublicUrl?: string | null
  env: Record<string, string | undefined>
}

/**
 * Build the deployment's client-resolution config. Throws
 * `OAuthClientConfigError` on malformed operator input, so call it once where a
 * throw fails the boot rather than one request.
 *
 * The CIMD URL is published **only** when the operator declared a public
 * origin. An authorization server has to fetch that document for the URL to be
 * a usable `client_id`, and a local-mode origin inferred from the request
 * (`http://localhost:5454`) is unreachable from one — offering it would make
 * the resolver prefer a document nobody can read over the dynamic registration
 * that works today. A deployment that declares its origin serves the document
 * at `/.well-known/oauth-client` (`routes/well-known-oauth-client.ts`).
 */
export const buildOAuthClientResolution = (
  input: OAuthClientResolutionInput,
): OAuthClientResolutionConfig => {
  const operatorClients = parseOperatorOAuthClients(input.env[OPERATOR_OAUTH_CLIENTS_ENV])
  return {
    ...(input.apiPublicUrl
      ? { clientIdMetadataDocumentUrl: buildClientIdMetadataDocumentUrl(input.apiPublicUrl) }
      : {}),
    ...(operatorClients.length > 0 ? { operatorClients } : {}),
  }
}
