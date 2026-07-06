import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  discoverOAuthServerConfig,
  generatePkcePair,
  parseResourceMetadataUrl,
  registerDynamicClient,
  OAuthDiscoveryError,
} from '../src/index.js'

/**
 * Discovery is exercised against a scripted fetch — no real traffic. Hosts
 * are IP literals so the SSRF guard passes without DNS.
 */

const SERVER = 'https://93.184.216.34/mcp'
const AS = 'https://93.184.216.35'

type Route = { status: number; json?: unknown; headers?: Record<string, string> }

const scriptedFetch = (routes: Record<string, Route>): typeof fetch => {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push(key)
    const route = routes[key] ?? routes[`GET ${url}`]
    if (!route) return new Response('not found', { status: 404 })
    return new Response(route.json !== undefined ? JSON.stringify(route.json) : '', {
      status: route.status,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    })
  }) as typeof fetch
  ;(impl as unknown as { calls: string[] }).calls = calls
  return impl
}

test('parseResourceMetadataUrl extracts the RFC 9728 pointer', () => {
  assert.equal(
    parseResourceMetadataUrl(
      'Bearer error="unauthorized", resource_metadata="https://x/.well-known/oauth-protected-resource"',
    ),
    'https://x/.well-known/oauth-protected-resource',
  )
  assert.equal(parseResourceMetadataUrl('Bearer realm="x"'), null)
  assert.equal(parseResourceMetadataUrl(null), null)
})

test('discoverOAuthServerConfig follows challenge → PRM → AS metadata', async () => {
  const fetchImpl = scriptedFetch({
    [`POST ${SERVER}`]: {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="https://93.184.216.34/.well-known/oauth-protected-resource/mcp"`,
      },
    },
    ['GET https://93.184.216.34/.well-known/oauth-protected-resource/mcp']: {
      status: 200,
      json: {
        resource: SERVER,
        authorization_servers: [AS],
        scopes_supported: ['mcp.read'],
      },
    },
    [`GET ${AS}/.well-known/oauth-authorization-server`]: {
      status: 200,
      json: {
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        code_challenge_methods_supported: ['S256'],
      },
    },
  })
  const config = await discoverOAuthServerConfig(SERVER, { fetchImpl })
  assert.ok(config)
  assert.equal(config.resource, SERVER)
  assert.equal(config.issuer, AS)
  assert.equal(config.authorizationEndpoint, `${AS}/authorize`)
  assert.equal(config.tokenEndpoint, `${AS}/token`)
  assert.equal(config.registrationEndpoint, `${AS}/register`)
  assert.deepEqual(config.scopesSupported, ['mcp.read'])
  assert.equal(config.supportsS256, true)
})

test('discoverOAuthServerConfig falls back to well-known PRM locations without a challenge pointer', async () => {
  const fetchImpl = scriptedFetch({
    [`POST ${SERVER}`]: { status: 401, headers: { 'www-authenticate': 'Bearer' } },
    ['GET https://93.184.216.34/.well-known/oauth-protected-resource/mcp']: {
      status: 200,
      json: { authorization_servers: [AS] },
    },
    [`GET ${AS}/.well-known/oauth-authorization-server`]: {
      status: 200,
      json: {
        authorization_endpoint: `${AS}/a`,
        token_endpoint: `${AS}/t`,
      },
    },
  })
  const config = await discoverOAuthServerConfig(SERVER, { fetchImpl })
  assert.equal(config?.authorizationEndpoint, `${AS}/a`)
  assert.equal(config?.registrationEndpoint, null)
})

test('discoverOAuthServerConfig uses spec-default endpoints for legacy challenged servers', async () => {
  const fetchImpl = scriptedFetch({
    [`POST ${SERVER}`]: { status: 401, headers: { 'www-authenticate': 'Bearer realm="mcp"' } },
  })
  const config = await discoverOAuthServerConfig(SERVER, { fetchImpl })
  assert.ok(config)
  assert.equal(config.authorizationEndpoint, 'https://93.184.216.34/authorize')
  assert.equal(config.tokenEndpoint, 'https://93.184.216.34/token')
  assert.equal(config.registrationEndpoint, 'https://93.184.216.34/register')
})

test('discoverOAuthServerConfig returns null for servers that never challenge', async () => {
  const fetchImpl = scriptedFetch({
    [`POST ${SERVER}`]: { status: 405 },
  })
  assert.equal(await discoverOAuthServerConfig(SERVER, { fetchImpl }), null)
})

test('registerDynamicClient posts RFC 7591 metadata and strips echoed secrets', async () => {
  let body: Record<string, unknown> = {}
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        client_id: 'client-123',
        client_secret: 'super-secret',
        registration_access_token: 'rat',
        client_name: 'Nessie',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  const result = await registerDynamicClient(
    {
      registrationEndpoint: `${AS}/register`,
      redirectUris: ['https://api.example/cb'],
      clientName: 'Nessie',
    },
    { fetchImpl },
  )
  assert.equal(result.clientId, 'client-123')
  assert.equal(result.clientSecret, 'super-secret')
  assert.equal(body['token_endpoint_auth_method'], 'none')
  assert.deepEqual(body['grant_types'], ['authorization_code', 'refresh_token'])
  assert.equal(result.raw['client_secret'], undefined)
  assert.equal(result.raw['registration_access_token'], undefined)
})

test('registerDynamicClient surfaces registration failures', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 400 })) as typeof fetch
  await assert.rejects(
    registerDynamicClient(
      { registrationEndpoint: `${AS}/register`, redirectUris: [], clientName: 'Nessie' },
      { fetchImpl },
    ),
    (error: unknown) => error instanceof OAuthDiscoveryError,
  )
})

test('generatePkcePair produces an S256 challenge of the verifier', () => {
  const { verifier, challenge } = generatePkcePair()
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url')
  assert.equal(challenge, expected)
  assert.ok(verifier.length >= 43)
  assert.notEqual(generatePkcePair().verifier, verifier)
})
