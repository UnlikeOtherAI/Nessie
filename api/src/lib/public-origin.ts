import type { FastifyRequest } from 'fastify'

import type { AppConfig } from './server-context.js'

/**
 * The one place a server-generated public URL (OAuth callback, dynamic client
 * registration redirect) may derive its origin from.
 *
 * Origin resolution order:
 *  1. The configured `api.publicUrl` — the deployment's declared public origin
 *     of the API. This is the only acceptable source in production: it is set
 *     by the operator, not by the request, so a hostile Host or
 *     X-Forwarded-* header cannot steer a callback elsewhere.
 *  2. Local/dev mode with no configured public URL — fall back to Fastify's
 *     trust-proxy-scoped `request.protocol` / `request.hostname`. These honour
 *     X-Forwarded-* ONLY when the socket peer matches the configured
 *     `trustedProxyHops` count (`createFastifyTrustProxyConfig`), never on a
 *     raw direct connection.
 *
 * Raw `x-forwarded-proto` / `x-forwarded-host` / `host` header reads are
 * banned outside the trust-proxy plumbing by ESLint (`no-restricted-syntax`
 * in the root config); this module reads only the trust-scoped getters.
 */

export class PublicOriginConfigError extends Error {
  readonly code = 'PUBLIC_ORIGIN_NOT_CONFIGURED'
}

/**
 * Extract just the `protocol://host` of a URL. `new URL().origin` already
 * normalizes case, strips default ports, drops any path/credentials, and
 * rejects malformed input — exactly the invariants a redirect URI needs.
 */
export const toPublicOrigin = (url: string): string | null => {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * Resolve the public origin for server-minted absolute URLs.
 *
 * Throws `PublicOriginConfigError` when the origin cannot be determined
 * safely (a hosted/selfHosted deployment with no `api.publicUrl`, or an
 * unparsable configured URL). Callers must surface this as a configuration
 * error rather than silently trusting request-derived values — dynamic
 * client registration turns a steered origin into a *persisted* wrong
 * redirect URI, so it is worse than cosmetic.
 */
export const resolvePublicOrigin = (
  request: Pick<FastifyRequest, 'protocol' | 'hostname'>,
  config: Pick<AppConfig, 'mode' | 'api'>,
): string => {
  if (config.api.publicUrl) {
    const origin = toPublicOrigin(config.api.publicUrl)
    if (origin) return origin
    throw new PublicOriginConfigError(
      `api.publicUrl (${config.api.publicUrl}) is not a valid http(s) URL; `
        + 'set NESSIE_API_PUBLIC_URL to the deployment public origin '
        + '(e.g. https://api.example.com)',
    )
  }
  if (config.mode !== 'local') {
    throw new PublicOriginConfigError(
      `api.publicUrl is required when NESSIE_MODE=${config.mode}: `
        + 'OAuth callback and registration origins must come from operator '
        + 'config, never from request headers. Set NESSIE_API_PUBLIC_URL to '
        + 'the public origin of this API (e.g. https://api.example.com)',
    )
  }
  return `${request.protocol}://${request.hostname}`
}
