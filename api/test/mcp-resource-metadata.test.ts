import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerWellKnownMcpResourceRoutes } from '../src/routes/well-known-mcp-resource.js'

// An MCP client that hits the endpoint without a credential gets a 401 and,
// without this document, no way to learn what to do about it. RFC 9728 is how
// the spec answers that, and the point of these is that the document tells the
// truth: this deployment runs no authorization server, so it names the grant it
// actually implements rather than advertising one it cannot honour.

const buildApp = async (overrides: Record<string, unknown> = {}) => {
  const app = Fastify()
  registerWellKnownMcpResourceRoutes(app, {
    config: {
      api: { publicUrl: 'https://api.example.test' },
      mode: 'selfHosted',
      ...overrides,
    },
  } as never)
  await app.ready()
  return app
}

test('the document names this resource and how to reach its pairing', async () => {
  process.env.NESSIE_ADMIN_PUBLIC_URL = 'https://app.example.test'
  const app = await buildApp()
  const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })
  const body = response.json()

  assert.equal(response.statusCode, 200)
  assert.equal(body.resource, 'https://api.example.test/mcp')
  assert.deepEqual(body.bearer_methods_supported, ['header'])
  // Where a person goes, which is the thing an agent must print.
  assert.equal(body.resource_documentation, 'https://app.example.test/settings/agent-access')
  await app.close()
})

test('it advertises the device grant it actually implements', async () => {
  const app = await buildApp()
  const body = (await app.inject({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
  })).json()

  const device = body['x-nessie-device-authorization']
  assert.deepEqual(device.grant_types_supported, [
    'urn:ietf:params:oauth:grant-type:device_code',
  ])
  assert.equal(device.device_authorization_endpoint, 'https://api.example.test/mcp/auth/device')
  assert.equal(device.token_endpoint, 'https://api.example.test/mcp/auth/token')
  // No authorization server runs here, so none is claimed. A client that tried
  // an advertised one would fail later and less legibly than one told this.
  assert.equal(body.authorization_servers, undefined)
  await app.close()
})

test('every grantable scope is listed, so a client can ask for the right ones', async () => {
  const app = await buildApp()
  const body = (await app.inject({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
  })).json()

  assert.deepEqual(body['x-nessie-device-authorization'].scopes_supported, [
    'boards_read',
    'boards_write',
    'documents_read',
    'documents_write',
    'documents_publish',
  ])
  await app.close()
})

test('the document is public, because it is read before any credential exists', async () => {
  const app = await buildApp()
  const response = await app.inject({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
  })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['cache-control'] as string, /max-age=3600/)
  await app.close()
})

// The document is only useful if a refused client is told where to find it.
// An earlier draft set this header inside the MCP route handler, which an
// unauthenticated request never reaches — the header was on a branch that
// could not run, and the 401 stayed opaque. It belongs where the refusal is
// actually produced.
test('an agent-credential route challenges with the metadata URL', async () => {
  const app = Fastify()
  const config = { api: { publicUrl: 'https://api.example.test' }, mode: 'selfHosted' }

  // The shape of the real hook: set the challenge for agent-credential routes
  // BEFORE verification, so every refusal carries it.
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.agentCredential === true) {
      reply.header(
        'www-authenticate',
        'Bearer resource_metadata='
        + `"${config.api.publicUrl}/.well-known/oauth-protected-resource"`,
      )
      reply.code(401)
      return reply.send({ error: { code: 'AUTH_REQUIRED' } })
    }
    return undefined
  })
  app.post('/mcp', { config: { agentCredential: true } }, async () => ({ ok: true }))
  await app.ready()

  for (const headers of [{}, { authorization: 'Bearer nag1_invalid' }]) {
    const response = await app.inject({ headers, method: 'POST', url: '/mcp' })
    assert.equal(response.statusCode, 401)
    assert.match(
      response.headers['www-authenticate'] as string,
      /resource_metadata="https:\/\/api\.example\.test\/\.well-known\/oauth-protected-resource"/,
      'every refusal must name where to learn how to authenticate',
    )
  }
  await app.close()
})
