/**
 * Which OAuth client identity Nessie presents to an authorization server, and
 * the document that identity points at.
 *
 * There are four ways to be a client, and they are NOT interchangeable, so the
 * choice is made once, here, as a pure function over what the authorization
 * server advertises plus what this deployment was configured with. `startOAuth`
 * consults it; nothing else decides.
 *
 * Preference order (MCP authorization spec + the OAuth Client ID Metadata
 * Document draft):
 *
 * 1. **Pre-registered** — the catalog entry already carries a client registered
 *    with this vendor by a human. A client somebody registered *for this app*
 *    outranks anything minted on the fly: it is the one whose scopes and
 *    consent screen were actually reviewed.
 * 2. **Client ID Metadata Document (CIMD)** — the client_id IS a URL the
 *    authorization server fetches. It registers nothing: no per-organization
 *    client row to rotate, no registration call to be rate-limited or refused.
 *    Gated on the server *advertising* `client_id_metadata_document_supported`,
 *    because to a server that has never heard of CIMD a URL is simply an
 *    unknown client_id and the flow dies at the authorize endpoint.
 * 3. **Dynamic Client Registration** (RFC 7591) — mint a client per
 *    organization × issuer. Works everywhere a `registration_endpoint` exists.
 * 4. **Operator-supplied** — a client_id/secret an operator copied from a
 *    vendor console for one authorization server. Last, because it is
 *    hand-maintained: it drifts from the deployment's real callback URL and
 *    nothing re-registers it when the deployment moves hosts.
 *
 * When none of 2–4 apply the answer is still `dynamic_registration`, not a
 * refusal: `ensureDynamicClient` reuses an organization's previously registered
 * client for an issuer that has since stopped advertising a registration
 * endpoint, and owns the actionable refusal for the case where it genuinely
 * cannot proceed. Pre-empting that here would break a working connection and
 * replace a precise message with a vaguer one.
 */

/** Where the deployment publishes its own client metadata document. */
export const CLIENT_ID_METADATA_DOCUMENT_PATH = '/.well-known/oauth-client'

/** Nessie's client name, identical in the CIMD document and in RFC 7591 DCR. */
export const OAUTH_CLIENT_NAME = 'Nessie'

export class OAuthClientConfigError extends Error {
  override readonly name = 'OAuthClientConfigError'
}

/** A client registered with one vendor ahead of time (catalog entry config). */
export type PreRegisteredOAuthClient = {
  clientId: string
  clientSecret?: string
}

/** An operator-named client for one authorization server, keyed by issuer. */
export type OperatorOAuthClient = {
  /** Issuer this client belongs to, as published in the AS metadata. */
  issuer: string
  clientId: string
  clientSecret?: string
}

/** Deployment-level configuration consulted by the resolver. */
export type OAuthClientResolutionConfig = {
  /**
   * Absolute URL of this deployment's published client metadata document —
   * `buildClientIdMetadataDocumentUrl(origin)`. Absent (or not http(s)) means
   * the deployment publishes none, so the CIMD tier is skipped: an
   * authorization server has to be able to fetch it for it to be a client.
   */
  clientIdMetadataDocumentUrl?: string
  operatorClients?: readonly OperatorOAuthClient[]
}

/** The facts about an authorization server the choice actually turns on. */
export type OAuthAuthorizationServerFacts = {
  issuer: string
  registrationEndpoint: string | null
  supportsClientIdMetadataDocument: boolean
}

export type OAuthClientStrategy =
  | { source: 'pre_registered'; clientId: string; clientSecret?: string }
  | { source: 'client_id_metadata_document'; clientId: string }
  | { source: 'operator'; clientId: string; clientSecret?: string }
  | { source: 'dynamic_registration' }

const isFetchableUrl = (value: string | undefined): value is string => {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Compare two issuer identifiers the way RFC 8414 means them: same scheme,
 * host and path, ignoring a trailing slash and a default port. An operator
 * writing `https://auth.example.com/` must match metadata publishing
 * `https://auth.example.com`, or the entry silently never applies.
 */
const sameIssuer = (a: string, b: string): boolean => {
  try {
    const left = new URL(a)
    const right = new URL(b)
    const path = (url: URL): string => url.pathname.replace(/\/+$/, '')
    return left.origin === right.origin && path(left) === path(right)
  } catch {
    return false
  }
}

export const findOperatorOAuthClient = (
  clients: readonly OperatorOAuthClient[] | undefined,
  issuer: string,
): OperatorOAuthClient | null =>
  clients?.find((client) => sameIssuer(client.issuer, issuer)) ?? null

export type ResolveOAuthClientInput = {
  /** Set when the app already ships a registered client (static catalog config). */
  preRegistered?: PreRegisteredOAuthClient | null
  /** Discovered authorization-server facts; absent on the static path. */
  server?: OAuthAuthorizationServerFacts | null
  config?: OAuthClientResolutionConfig
}

export const resolveOAuthClientStrategy = (
  input: ResolveOAuthClientInput,
): OAuthClientStrategy => {
  const { preRegistered, server } = input
  const config = input.config ?? {}

  if (preRegistered && preRegistered.clientId.length > 0) {
    return {
      source: 'pre_registered',
      clientId: preRegistered.clientId,
      ...(preRegistered.clientSecret ? { clientSecret: preRegistered.clientSecret } : {}),
    }
  }

  if (
    server?.supportsClientIdMetadataDocument
    && isFetchableUrl(config.clientIdMetadataDocumentUrl)
  ) {
    // Under CIMD the document's URL *is* the client_id — there is nothing else
    // to send and nothing to persist.
    return {
      source: 'client_id_metadata_document',
      clientId: config.clientIdMetadataDocumentUrl,
    }
  }

  if (server?.registrationEndpoint) {
    return { source: 'dynamic_registration' }
  }

  const operator = server
    ? findOperatorOAuthClient(config.operatorClients, server.issuer)
    : null
  if (operator) {
    return {
      source: 'operator',
      clientId: operator.clientId,
      ...(operator.clientSecret ? { clientSecret: operator.clientSecret } : {}),
    }
  }

  return { source: 'dynamic_registration' }
}

// ─── The published document ─────────────────────────────────────────────────

/**
 * RFC 7591 client metadata, served publicly so an authorization server can
 * fetch it and learn who is asking. The `client_id` MUST equal the document's
 * own URL — that self-reference is the whole security property of CIMD, so the
 * URL and the document are built from one input here rather than stated twice.
 */
export type ClientIdMetadataDocument = {
  client_id: string
  client_name: string
  client_uri?: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: 'none'
}

const requireHttpUrl = (value: string, field: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OAuthClientConfigError(`${field} must be an absolute URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OAuthClientConfigError(`${field} must be an http(s) URL`)
  }
  return url
}

/**
 * `origin` comes from the caller's `resolvePublicOrigin` — never from a
 * request header — so the client_id an authorization server fetches is the one
 * this deployment actually serves.
 */
export const buildClientIdMetadataDocumentUrl = (apiPublicOrigin: string): string => {
  const origin = requireHttpUrl(apiPublicOrigin, 'apiPublicOrigin')
  return new URL(CLIENT_ID_METADATA_DOCUMENT_PATH, origin.origin).toString()
}

export type ClientIdMetadataDocumentInput = {
  /** Public origin of the API, e.g. `https://api.nessie.works`. */
  apiPublicOrigin: string
  /** The absolute OAuth callback URL `startOAuth` sends as `redirect_uri`. */
  callbackUrl: string
  /** Product URL shown on the provider's consent screen, when there is one. */
  clientUri?: string
}

export const buildClientIdMetadataDocument = (
  input: ClientIdMetadataDocumentInput,
): ClientIdMetadataDocument => {
  const clientId = buildClientIdMetadataDocumentUrl(input.apiPublicOrigin)
  const callbackUrl = requireHttpUrl(input.callbackUrl, 'callbackUrl').toString()
  return {
    client_id: clientId,
    client_name: OAUTH_CLIENT_NAME,
    ...(input.clientUri
      ? { client_uri: requireHttpUrl(input.clientUri, 'clientUri').toString() }
      : {}),
    redirect_uris: [callbackUrl],
    // Identical to the RFC 7591 registration body in `registerDynamicClient`:
    // one client identity, however it reaches the authorization server.
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}
