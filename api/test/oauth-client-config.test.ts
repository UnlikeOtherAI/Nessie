import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLIENT_ID_METADATA_DOCUMENT_PATH,
  OAuthClientConfigError,
  findOperatorOAuthClient,
  resolveOAuthClientStrategy,
} from '@nessie/mcp-manage'

import {
  OPERATOR_OAUTH_CLIENTS_ENV,
  buildOAuthClientResolution,
  parseOperatorOAuthClients,
} from '../src/lib/oauth-client-config.js'

/**
 * The deployment half of OAuth client resolution: what an operator declares
 * (public origin, per-issuer clients) becomes the config the shared resolver
 * consults. Every assertion runs the built config through
 * `resolveOAuthClientStrategy` as well as reading it, because a config the
 * resolver ignores is the defect this module exists to close.
 */

const API_ORIGIN = 'https://api.nessie.works'
const CIMD_URL = `${API_ORIGIN}${CLIENT_ID_METADATA_DOCUMENT_PATH}`

const ISSUER_A = 'https://auth.a.example'
const ISSUER_B = 'https://auth.b.example'

const envWithClients = (clients: unknown): Record<string, string | undefined> => ({
  [OPERATOR_OAUTH_CLIENTS_ENV]: JSON.stringify(clients),
})

const serverFacts = (
  issuer: string,
  options: { registration?: boolean; cimd?: boolean } = {},
) => ({
  issuer,
  registrationEndpoint: options.registration ? `${issuer}/register` : null,
  supportsClientIdMetadataDocument: options.cimd ?? false,
})

test('a deployment with no operator clients still publishes its CIMD URL', () => {
  const config = buildOAuthClientResolution({ apiPublicUrl: API_ORIGIN, env: {} })

  assert.equal(config.clientIdMetadataDocumentUrl, CIMD_URL)
  assert.equal(config.operatorClients, undefined)

  // The tier is reachable: a server advertising CIMD support now gets the
  // document URL as its client_id instead of a registration call.
  assert.deepEqual(
    resolveOAuthClientStrategy({
      server: serverFacts(ISSUER_A, { registration: true, cimd: true }),
      config,
    }),
    { source: 'client_id_metadata_document', clientId: CIMD_URL },
  )
})

test('a public URL carrying a path still yields the origin-rooted document URL', () => {
  const config = buildOAuthClientResolution({
    apiPublicUrl: `${API_ORIGIN}/api/`,
    env: {},
  })

  assert.equal(config.clientIdMetadataDocumentUrl, CIMD_URL)
})

test('an undeclared public origin publishes no CIMD URL and falls through to DCR', () => {
  // Local mode with no NESSIE_API_PUBLIC_URL: the origin would be a loopback
  // address no authorization server can fetch, so offering it as a client_id
  // would break a flow that dynamic registration handles today.
  const config = buildOAuthClientResolution({ env: {} })

  assert.deepEqual(config, {})
  assert.deepEqual(
    resolveOAuthClientStrategy({
      server: serverFacts(ISSUER_A, { registration: true, cimd: true }),
      config,
    }),
    { source: 'dynamic_registration' },
  )
})

test('an operator client is offered only to its own authorization server', () => {
  const config = buildOAuthClientResolution({
    apiPublicUrl: API_ORIGIN,
    env: envWithClients([
      { issuer: ISSUER_A, clientId: 'client-a', clientSecret: 'secret-a' },
      // Trailing slash on purpose: RFC 8414 issuer comparison, not string
      // equality, is what decides whether an entry ever applies.
      { issuer: `${ISSUER_B}/`, clientId: 'client-b' },
    ]),
  })

  assert.deepEqual(
    findOperatorOAuthClient(config.operatorClients, ISSUER_B),
    { issuer: `${ISSUER_B}/`, clientId: 'client-b' },
  )
  assert.deepEqual(
    resolveOAuthClientStrategy({ server: serverFacts(ISSUER_A), config }),
    { source: 'operator', clientId: 'client-a', clientSecret: 'secret-a' },
  )
  assert.deepEqual(
    resolveOAuthClientStrategy({ server: serverFacts(ISSUER_B), config }),
    { source: 'operator', clientId: 'client-b' },
  )
  // A server nobody configured a client for gets none of them.
  assert.equal(findOperatorOAuthClient(config.operatorClients, 'https://auth.c.example'), null)
  assert.deepEqual(
    resolveOAuthClientStrategy({ server: serverFacts('https://auth.c.example'), config }),
    { source: 'dynamic_registration' },
  )
})

test('a pre-registered client outranks every deployment-configured tier', () => {
  const config = buildOAuthClientResolution({
    apiPublicUrl: API_ORIGIN,
    env: envWithClients([{ issuer: ISSUER_A, clientId: 'client-a', clientSecret: 'secret-a' }]),
  })

  assert.deepEqual(
    resolveOAuthClientStrategy({
      preRegistered: { clientId: 'catalog-client' },
      server: serverFacts(ISSUER_A, { cimd: true }),
      config,
    }),
    { source: 'pre_registered', clientId: 'catalog-client' },
  )
})

const rejected: ReadonlyArray<[string, string]> = [
  ['not JSON at all', '{'],
  ['a JSON object instead of an array', '{"issuer":"https://auth.a.example"}'],
  ['an entry that is not an object', '["https://auth.a.example"]'],
  ['an entry with an unknown field', '[{"issuer":"https://auth.a.example","client_id":"a"}]'],
  ['an entry with no clientId', '[{"issuer":"https://auth.a.example"}]'],
  ['an entry with a blank clientId', '[{"issuer":"https://auth.a.example","clientId":"  "}]'],
  ['an entry with a blank clientSecret', '[{"issuer":"https://a.example","clientId":"a","clientSecret":""}]'],
  ['an issuer that is not a URL', '[{"issuer":"auth.a.example","clientId":"a"}]'],
  ['an issuer that is not http(s)', '[{"issuer":"ftp://auth.a.example","clientId":"a"}]'],
  [
    'two entries the resolver cannot tell apart',
    '[{"issuer":"https://auth.a.example","clientId":"a"},{"issuer":"https://auth.a.example/","clientId":"b"}]',
  ],
]

test('a malformed operator entry is rejected, never silently ignored', () => {
  for (const [description, raw] of rejected) {
    assert.throws(
      () => parseOperatorOAuthClients(raw),
      (error: unknown) =>
        error instanceof OAuthClientConfigError
        && error.message.startsWith(`${OPERATOR_OAUTH_CLIENTS_ENV}:`),
      `expected ${description} to be rejected`,
    )
    // The same refusal reaches the composition root, so a bad value fails the
    // boot rather than one authorize request.
    assert.throws(
      () => buildOAuthClientResolution({
        apiPublicUrl: API_ORIGIN,
        env: { [OPERATOR_OAUTH_CLIENTS_ENV]: raw },
      }),
      OAuthClientConfigError,
    )
  }
})

test('a rejection message names the field, never the value', () => {
  assert.throws(
    () => parseOperatorOAuthClients(
      JSON.stringify([
        { issuer: ISSUER_A, clientId: 'client-a', clientSecret: 'super-secret', extra: 1 },
      ]),
    ),
    (error: unknown) =>
      error instanceof OAuthClientConfigError
      && !error.message.includes('super-secret')
      && error.message.includes('entry 0'),
  )
})

test('an unset or empty operator list is not an error', () => {
  assert.deepEqual(parseOperatorOAuthClients(undefined), [])
  assert.deepEqual(parseOperatorOAuthClients('   '), [])
  assert.deepEqual(parseOperatorOAuthClients('[]'), [])
  assert.deepEqual(
    buildOAuthClientResolution({ apiPublicUrl: API_ORIGIN, env: { OTHER: 'x' } }),
    { clientIdMetadataDocumentUrl: CIMD_URL },
  )
})

test('a malformed public URL is an operator error, not a silent skip', () => {
  assert.throws(
    () => buildOAuthClientResolution({ apiPublicUrl: 'nessie://app', env: {} }),
    OAuthClientConfigError,
  )
})
