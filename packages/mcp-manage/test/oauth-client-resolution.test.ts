import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLIENT_ID_METADATA_DOCUMENT_PATH,
  OAuthClientConfigError,
  buildClientIdMetadataDocument,
  buildClientIdMetadataDocumentUrl,
  resolveOAuthClientStrategy,
  type OAuthAuthorizationServerFacts,
  type OAuthClientResolutionConfig,
} from '../src/oauth-client-resolution.js'

/**
 * The OAuth client preference order, tested as a pure decision: which client
 * identity Nessie presents, given what an authorization server advertises and
 * what the deployment was configured with. No HTTP, no Prisma — if this file
 * needs either, the order has leaked back into the flow.
 */

const ISSUER = 'https://auth.example.com'
const CIMD_URL = 'https://api.nessie.works/.well-known/oauth-client'

const server = (
  overrides: Partial<OAuthAuthorizationServerFacts> = {},
): OAuthAuthorizationServerFacts => ({
  issuer: ISSUER,
  registrationEndpoint: `${ISSUER}/register`,
  supportsClientIdMetadataDocument: false,
  ...overrides,
})

const everythingAvailable: OAuthClientResolutionConfig = {
  clientIdMetadataDocumentUrl: CIMD_URL,
  operatorClients: [
    { issuer: ISSUER, clientId: 'operator-client', clientSecret: 'operator-secret' },
  ],
}

// ─── order ──────────────────────────────────────────────────────────────────

test('a pre-registered client outranks CIMD, registration and operator config', () => {
  const strategy = resolveOAuthClientStrategy({
    preRegistered: { clientId: 'vendor-client', clientSecret: 'vendor-secret' },
    server: server({ supportsClientIdMetadataDocument: true }),
    config: everythingAvailable,
  })
  assert.equal(strategy.source, 'pre_registered')
  assert.equal(strategy.source === 'pre_registered' && strategy.clientId, 'vendor-client')
  assert.equal(
    strategy.source === 'pre_registered' && strategy.clientSecret,
    'vendor-secret',
  )
})

test('CIMD is chosen over registration when the server advertises support', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ supportsClientIdMetadataDocument: true }),
    config: everythingAvailable,
  })
  assert.equal(strategy.source, 'client_id_metadata_document')
  // Under CIMD the document's URL *is* the client_id.
  assert.equal(
    strategy.source === 'client_id_metadata_document' && strategy.clientId,
    CIMD_URL,
  )
})

test('a server that does not advertise CIMD falls through to dynamic registration', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ supportsClientIdMetadataDocument: false }),
    config: everythingAvailable,
  })
  // Sending a URL as client_id to a server that never said it would fetch one
  // is just an unknown client, so the capability gate is not advisory.
  assert.equal(strategy.source, 'dynamic_registration')
})

test('CIMD is skipped when this deployment publishes no document', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ supportsClientIdMetadataDocument: true }),
    config: { operatorClients: everythingAvailable.operatorClients },
  })
  assert.equal(strategy.source, 'dynamic_registration')
})

test('CIMD is skipped when the configured document URL is not fetchable', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ supportsClientIdMetadataDocument: true }),
    config: { clientIdMetadataDocumentUrl: 'file:///etc/oauth-client.json' },
  })
  assert.equal(strategy.source, 'dynamic_registration')
})

test('an operator client is used when the server offers no registration endpoint', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ registrationEndpoint: null }),
    config: everythingAvailable,
  })
  assert.equal(strategy.source, 'operator')
  assert.equal(strategy.source === 'operator' && strategy.clientId, 'operator-client')
  assert.equal(
    strategy.source === 'operator' && strategy.clientSecret,
    'operator-secret',
  )
})

test('operator issuers match RFC 8414 style — trailing slash and default port ignored', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ issuer: 'https://auth.example.com:443', registrationEndpoint: null }),
    config: {
      operatorClients: [{ issuer: 'https://auth.example.com/', clientId: 'op' }],
    },
  })
  assert.equal(strategy.source, 'operator')
})

test('an operator client for another issuer never applies', () => {
  const strategy = resolveOAuthClientStrategy({
    server: server({ registrationEndpoint: null }),
    config: {
      operatorClients: [{ issuer: 'https://other.example.com', clientId: 'op' }],
    },
  })
  assert.equal(strategy.source, 'dynamic_registration')
})

test('with nothing configured the answer stays dynamic_registration', () => {
  // Deliberately NOT a refusal: `ensureDynamicClient` still reuses an
  // organization's already-registered client for an issuer that has since
  // stopped advertising a registration endpoint, and owns the precise refusal
  // when it genuinely cannot proceed.
  const strategy = resolveOAuthClientStrategy({
    server: server({ registrationEndpoint: null }),
  })
  assert.equal(strategy.source, 'dynamic_registration')
})

test('a pre-registered public client carries no secret', () => {
  const strategy = resolveOAuthClientStrategy({
    preRegistered: { clientId: 'public-client' },
  })
  assert.equal(strategy.source, 'pre_registered')
  assert.equal('clientSecret' in strategy, false)
})

// ─── the published document ─────────────────────────────────────────────────

test('the client metadata document declares itself as its own client_id', () => {
  const doc = buildClientIdMetadataDocument({
    apiPublicOrigin: 'https://api.nessie.works',
    callbackUrl: 'https://api.nessie.works/api/mcp/oauth/callback',
    clientUri: 'https://app.nessie.works',
  })
  // The self-reference is the whole security property of CIMD.
  assert.equal(
    doc.client_id,
    buildClientIdMetadataDocumentUrl('https://api.nessie.works'),
  )
  assert.equal(
    doc.client_id,
    `https://api.nessie.works${CLIENT_ID_METADATA_DOCUMENT_PATH}`,
  )
  assert.deepEqual(doc.redirect_uris, [
    'https://api.nessie.works/api/mcp/oauth/callback',
  ])
  assert.equal(doc.client_name, 'Nessie')
  assert.equal(doc.client_uri, 'https://app.nessie.works/')
  // Same client identity RFC 7591 registration announces, so a server sees one
  // Nessie whichever mechanism it uses.
  assert.deepEqual(doc.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(doc.response_types, ['code'])
  assert.equal(doc.token_endpoint_auth_method, 'none')
})

test('the document builder refuses an origin or callback that is not http(s)', () => {
  assert.throws(
    () => buildClientIdMetadataDocumentUrl('nessie://app'),
    (error: unknown) => error instanceof OAuthClientConfigError,
  )
  assert.throws(
    () => buildClientIdMetadataDocument({
      apiPublicOrigin: 'https://api.nessie.works',
      callbackUrl: 'not-a-url',
    }),
    (error: unknown) => error instanceof OAuthClientConfigError,
  )
})

test('a document URL ignores any path on the configured origin', () => {
  // It is an origin, not a base path: the route is served at the root.
  assert.equal(
    buildClientIdMetadataDocumentUrl('https://api.nessie.works/api/'),
    `https://api.nessie.works${CLIENT_ID_METADATA_DOCUMENT_PATH}`,
  )
})
