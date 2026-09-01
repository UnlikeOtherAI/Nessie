import {
  CLIENT_ID_METADATA_DOCUMENT_PATH,
  OAuthClientConfigError,
  buildClientIdMetadataDocument,
  type ClientIdMetadataDocument,
} from '@nessie/mcp-manage'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { sendApiError } from '../lib/api.js'
import { PublicOriginConfigError, resolvePublicOrigin } from '../lib/public-origin.js'
import type { AppConfig } from '../lib/server-context.js'
import {
  buildOAuthCallbackUrl,
  resolveAdminOrigin,
  sendPublicOriginError,
} from './mcp/oauth.js'

/**
 * Publish this deployment's OAuth Client ID Metadata Document (CIMD).
 *
 * An authorization server that advertises
 * `client_id_metadata_document_supported` accepts a **URL** as the `client_id`
 * and fetches that URL to learn who is asking — no RFC 7591 registration call,
 * no per-organization client row to rotate. That is why
 * `resolveOAuthClientStrategy` prefers CIMD over Dynamic Client Registration,
 * and it only works if the URL it hands the server resolves to this document.
 *
 * The document itself is built by `@nessie/mcp-manage`
 * (`buildClientIdMetadataDocument`), the same module the resolver lives in, so
 * the client identity Nessie *presents* and the one it *publishes* cannot
 * drift; this route only supplies the deployment facts and serves the result.
 *
 * Public by design: the fetch arrives from an authorization server's backend
 * before the person has any session here. Nothing in the document is secret —
 * a public client authenticates with PKCE, which is why
 * `token_endpoint_auth_method` is `none` and there is no secret to leak.
 */

export type WellKnownOAuthClientDeps = {
  config: AppConfig
}

/**
 * Build the document for one request. Every value is server-authored: the
 * origin comes from `resolvePublicOrigin` (configured `api.publicUrl`, or the
 * trust-proxy-scoped host in local mode — never a raw Host/X-Forwarded-Host
 * header), and the redirect URI comes from the callback route's own builder
 * rather than a second copy of the path, so the document cannot advertise a
 * URI the handshake never sends.
 */
export const buildOAuthClientMetadataDocument = (
  request: FastifyRequest,
  config: AppConfig,
): ClientIdMetadataDocument => {
  const adminOrigin = resolveAdminOrigin(config)
  return buildClientIdMetadataDocument({
    apiPublicOrigin: resolvePublicOrigin(request, config),
    callbackUrl: buildOAuthCallbackUrl(request, config),
    // Where a person actually uses Nessie, so a consent screen naming this
    // client links somewhere a human recognises. A deployment that has not
    // declared its admin origin publishes no `client_uri` at all rather than
    // pointing the screen at an API host nobody visits.
    ...(adminOrigin ? { clientUri: adminOrigin } : {}),
  })
}

export const registerWellKnownOAuthClientRoutes = (
  app: FastifyInstance,
  deps: WellKnownOAuthClientDeps,
): void => {
  const { config } = deps

  app.get(
    CLIENT_ID_METADATA_DOCUMENT_PATH,
    { config: { public: true } },
    async (request, reply) => {
      let document: ClientIdMetadataDocument
      try {
        document = buildOAuthClientMetadataDocument(request, config)
      } catch (error) {
        if (error instanceof PublicOriginConfigError) {
          sendPublicOriginError(reply)
          return reply
        }
        // A malformed origin is an operator error too, and the message is
        // server-authored (it names the field, never the request).
        if (error instanceof OAuthClientConfigError) {
          sendApiError(reply, 500, 'OAUTH_CLIENT_METADATA_UNAVAILABLE', error.message)
          return reply
        }
        throw error
      }
      return reply
        .type('application/json')
        // Authorization servers re-fetch this per authorization request; it
        // only changes when the deployment's origin does.
        .header('cache-control', 'public, max-age=3600')
        .send(document)
    },
  )
}
