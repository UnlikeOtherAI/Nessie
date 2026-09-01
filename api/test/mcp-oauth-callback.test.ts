import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import type { PrismaClient } from '@prisma/client'

import {
  buildOAuthCallbackPage,
  registerMcpOAuthRoutes,
  resolveAdminOrigin,
} from '../src/routes/mcp/oauth.js'
import { registerGlobalAuthHook } from '../src/lib/global-auth-hook.js'
import { registerWellKnownOAuthClientRoutes } from '../src/routes/well-known-oauth-client.js'
import { RateLimiter } from '../src/services/rate-limit.js'
import type { SecretStore } from '@nessie/mcp-manage'

/**
 * Task #39 — pin the OAuth callback's handling of the upstream `error` param.
 *
 * Providers are free to send any string in `?error=` (and `?error_description=`),
 * and a browser following the redirect will land on our endpoint with whatever
 * the attacker-controlled provider URL contained. Echoing the raw value into
 * the response body — or worse, into a redirect URL — enables reflected XSS
 * and open-redirect amplification.
 *
 * The hardened route:
 *   • collapses the `error` param to the RFC 6749 §4.1.2.1 enumeration; any
 *     value outside that set becomes `invalid_request`,
 *   • NEVER echoes `error_description` to the client (only logs it server-side).
 */

const makeApp = (
  configOverrides: Record<string, unknown> = {},
  beforeRoutes?: (app: ReturnType<typeof Fastify>) => void,
) => {
  const app = Fastify({ logger: false })
  const oauthSecretStore: SecretStore = { put: async () => 'secret_stub' }
  // The unauthenticated callback passes through the brute-force guard first:
  // fake the limiter store (always under the limit) and the audit hash-chain
  // reads the lockout path would need.
  const rateLimitTx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async () => ({}),
      findFirst: async () => null,
    },
  }
  const rateLimiter = new RateLimiter(
    {
      $queryRaw: async () => [{ count: 1 }],
      $executeRaw: async () => 0,
      $transaction: async <T>(callback: (tx: typeof rateLimitTx) => Promise<T>) =>
        callback(rateLimitTx),
    } as unknown as PrismaClient,
    { error: () => {} },
  )
  const config = {
    api: {
      rateLimit: {
        mcpOauthIp: { max: 100, windowMs: 60_000 },
      },
    },
    ...configOverrides,
  }
  beforeRoutes?.(app)
  registerMcpOAuthRoutes(app, {
    prisma: {} as unknown as PrismaClient,
    config,
    rateLimiter,
    requireActorContext: () => null,
    requireOwner: () => false,
    oauthSecretStore,
  })
  return app
}

test('global authentication hook leaves only the OAuth callback public', async () => {
  const authenticatedRequests: string[] = []
  const app = makeApp({}, (fastify) => {
    registerGlobalAuthHook(fastify, {
      checkRateLimit: () => null,
      authenticateRequest: async (request, reply) => {
        authenticatedRequests.push(request.routeOptions.url)
        reply.code(401).send({ error: { code: 'AUTH_REQUIRED' } })
        return null
      },
    })
  })

  const callback = await app.inject({
    method: 'GET',
    url: '/api/mcp/oauth/callback?error=access_denied',
  })
  assert.equal(callback.statusCode, 400)
  assert.equal(authenticatedRequests.length, 0)

  const start = await app.inject({
    method: 'POST',
    url: '/api/mcp/instances/instance-1/oauth/start',
  })
  assert.equal(start.statusCode, 401)
  assert.deepEqual(authenticatedRequests, ['/api/mcp/instances/:instanceId/oauth/start'])
  await app.close()
})

test('OAuth callback collapses HTML/script payload in `error` to invalid_request', async () => {
  const app = makeApp()
  // Classic reflected-XSS payload smuggled via ?error=…
  const malicious = '<htmltag>"><script>alert(1)</script>'
  const response = await app.inject({
    method: 'GET',
    url: `/api/mcp/oauth/callback?error=${encodeURIComponent(malicious)}`
      + `&error_description=${encodeURIComponent('<img src=x onerror=alert(2)>')}`,
  })
  assert.equal(response.statusCode, 400)
  const body = JSON.parse(response.body) as {
    error?: { code?: string; message?: string }
  }
  assert.equal(body.error?.code, 'MCP_OAUTH_PROVIDER_ERROR')
  // The malicious payload must NOT appear anywhere in the response body —
  // not the raw value, not the description, not URL-encoded.
  assert.equal(
    response.body.includes('<script>'),
    false,
    `raw payload echoed: ${response.body}`,
  )
  assert.equal(
    response.body.includes('onerror'),
    false,
    `error_description echoed: ${response.body}`,
  )
  assert.equal(
    response.body.includes(malicious),
    false,
    `raw error echoed: ${response.body}`,
  )
  // The sanitized fallback IS expected to appear in the message body.
  assert.ok(
    body.error?.message?.includes('invalid_request'),
    `expected sanitized invalid_request, got: ${body.error?.message}`,
  )
  await app.close()
})

test('OAuth callback echoes a whitelisted RFC 6749 error code verbatim', async () => {
  const app = makeApp()
  const response = await app.inject({
    method: 'GET',
    url: '/api/mcp/oauth/callback?error=access_denied',
  })
  assert.equal(response.statusCode, 400)
  const body = JSON.parse(response.body) as {
    error?: { code?: string; message?: string }
  }
  assert.equal(body.error?.code, 'MCP_OAUTH_PROVIDER_ERROR')
  // `access_denied` is a member of the RFC 6749 §4.1.2.1 enumeration so it
  // is safe to surface to the client (the message must reflect it back
  // unchanged for debuggability).
  assert.ok(
    body.error?.message?.includes('access_denied'),
    `expected access_denied passed through, got: ${body.error?.message}`,
  )
  await app.close()
})

test('OAuth callback never reflects upstream error_description to the client', async () => {
  const app = makeApp()
  const secret = 'totally-private-server-state-leaked-via-description'
  const response = await app.inject({
    method: 'GET',
    url: `/api/mcp/oauth/callback?error=server_error`
      + `&error_description=${encodeURIComponent(secret)}`,
  })
  assert.equal(response.statusCode, 400)
  assert.equal(
    response.body.includes(secret),
    false,
    `error_description leaked into response: ${response.body}`,
  )
  await app.close()
})

/**
 * Phase 5 — the callback page now tells its opener the flow finished.
 *
 * That is the one thing the page does beyond rendering a sentence, and it is
 * exactly where a reflected-XSS or message-leak regression would land, so the
 * properties below are pinned:
 *   • the postMessage target origin comes from operator configuration, never
 *     from anything in the request (query, Host, Origin, Referer),
 *   • `'*'` is never the target — a wildcard would hand "this person just
 *     linked <provider>" to whatever page opened this one,
 *   • a hostile `?error=` payload still cannot reach the body, on the HTML
 *     branch as well as the JSON one the tests above pin.
 */

const ADMIN_ORIGIN_ENV = 'NESSIE_ADMIN_PUBLIC_URL'

/** Run `fn` with the admin origin configured, restoring the env afterwards. */
const withAdminOrigin = async <T>(value: string | null, fn: () => Promise<T>): Promise<T> => {
  const previous = process.env[ADMIN_ORIGIN_ENV]
  const previousFallback = process.env['NESSIE_ADMIN_ORIGIN']
  delete process.env['NESSIE_ADMIN_ORIGIN']
  if (value === null) delete process.env[ADMIN_ORIGIN_ENV]
  else process.env[ADMIN_ORIGIN_ENV] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[ADMIN_ORIGIN_ENV]
    else process.env[ADMIN_ORIGIN_ENV] = previous
    if (previousFallback === undefined) delete process.env['NESSIE_ADMIN_ORIGIN']
    else process.env['NESSIE_ADMIN_ORIGIN'] = previousFallback
  }
}

/** The second argument of the page's `postMessage`, as it appears in source. */
const postMessageTarget = (html: string): string | null => {
  const match = /var target = ("[^"]*");/.exec(html)
  return match?.[1] ?? null
}

test('callback page posts a fixed message to the configured admin origin', async () => {
  const page = buildOAuthCallbackPage({ ok: true }, 'https://admin.example.test')
  assert.ok(page.html.includes('window.opener.postMessage(message, target)'))
  assert.equal(postMessageTarget(page.html), '"https://admin.example.test"')
  assert.ok(
    page.html.includes('{"source":"nessie","kind":"mcp-oauth","ok":true}'),
    `unexpected payload: ${page.html}`,
  )
})

test('callback failure page carries ok:false plus the sanitized RFC 6749 code', async () => {
  const page = buildOAuthCallbackPage(
    { ok: false, error: 'access_denied' },
    'https://admin.example.test',
  )
  assert.ok(
    page.html.includes(
      '{"source":"nessie","kind":"mcp-oauth","ok":false,"error":"access_denied"}',
    ),
    `unexpected payload: ${page.html}`,
  )
  assert.equal(postMessageTarget(page.html), '"https://admin.example.test"')
})

test('callback page never uses `*` as a postMessage target', async () => {
  const pages = [
    buildOAuthCallbackPage({ ok: true }, 'https://admin.example.test'),
    buildOAuthCallbackPage({ ok: false, error: 'server_error' }, 'https://admin.example.test'),
    buildOAuthCallbackPage({ ok: true }, null),
    buildOAuthCallbackPage({ ok: false, error: 'invalid_request' }, null),
  ]
  for (const page of pages) {
    const target = postMessageTarget(page.html)
    assert.equal(target === '"*"', false, `wildcard postMessage target: ${page.html}`)
    assert.equal(
      page.html.includes("postMessage(message, '*')"),
      false,
      `wildcard postMessage target: ${page.html}`,
    )
    if (target !== null) assert.match(target, /^"https?:\/\/[a-z0-9.:-]+"$/i)
  }
})

test('callback page ships no script at all when no admin origin is configured', async () => {
  const page = buildOAuthCallbackPage({ ok: true }, null)
  assert.equal(page.html.includes('<script'), false, `unexpected script: ${page.html}`)
  assert.equal(page.html.includes('postMessage'), false, `unexpected postMessage: ${page.html}`)
  // With nothing to execute, the page says so rather than leaving the door ajar.
  assert.ok(page.csp.includes("script-src 'none'"), page.csp)
})

test('callback page CSP pins its inline script and style by hash', async () => {
  const page = buildOAuthCallbackPage({ ok: true }, 'https://admin.example.test')
  assert.match(page.csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/)
  assert.match(page.csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/)
  assert.equal(page.csp.includes('unsafe-inline'), false, page.csp)
  assert.ok(page.csp.includes("default-src 'none'"), page.csp)
})

test('admin origin comes from operator config only, normalised and validated', async () => {
  await withAdminOrigin('https://admin.example.test/settings/connections', async () => {
    // Path, query and case are dropped: an origin is scheme + host + port.
    assert.equal(resolveAdminOrigin({ mode: 'selfHosted' }), 'https://admin.example.test')
  })
  await withAdminOrigin('javascript:alert(1)', async () => {
    assert.equal(resolveAdminOrigin({ mode: 'selfHosted' }), null)
  })
  await withAdminOrigin('not-a-url', async () => {
    assert.equal(resolveAdminOrigin({ mode: 'selfHosted' }), null)
  })
  await withAdminOrigin(null, async () => {
    // Local dev has one fixed admin port (CLAUDE.md → Ports); a hosted
    // deployment that declared nothing gets null, never a guess.
    assert.equal(resolveAdminOrigin({ mode: 'local' }), 'http://localhost:5455')
    assert.equal(resolveAdminOrigin({ mode: 'selfHosted' }), null)
  })
})

test('callback HTML takes its origin from config, never from request input', async () => {
  await withAdminOrigin('https://admin.example.test', async () => {
    const app = makeApp()
    const hostile = 'https://evil.example'
    const response = await app.inject({
      method: 'GET',
      url: '/api/mcp/oauth/callback?error=access_denied'
        + `&origin=${encodeURIComponent(hostile)}`
        + `&redirect_uri=${encodeURIComponent(hostile)}`
        + `&return_to=${encodeURIComponent(hostile)}`,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
        origin: hostile,
        referer: `${hostile}/attack`,
      },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.headers['content-type']?.includes('text/html'), true)
    assert.equal(postMessageTarget(response.body), '"https://admin.example.test"')
    assert.equal(
      response.body.includes('evil.example'),
      false,
      `request input reached the page: ${response.body}`,
    )
    // Nothing may redirect either — the page is the whole response.
    assert.equal(response.headers['location'], undefined)
    await app.close()
  })
})

test('callback HTML still collapses a hostile ?error payload', async () => {
  await withAdminOrigin('https://admin.example.test', async () => {
    const app = makeApp()
    const malicious = '</script><script>alert(1)</script>'
    const response = await app.inject({
      method: 'GET',
      url: `/api/mcp/oauth/callback?error=${encodeURIComponent(malicious)}`
        + `&error_description=${encodeURIComponent('<img src=x onerror=alert(2)>')}`,
      headers: { accept: 'text/html' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(
      response.body.includes('alert(1)'),
      false,
      `raw payload echoed: ${response.body}`,
    )
    assert.equal(
      response.body.includes('onerror'),
      false,
      `error_description echoed: ${response.body}`,
    )
    assert.equal(
      response.body.includes(malicious),
      false,
      `raw error echoed: ${response.body}`,
    )
    assert.ok(
      response.body.includes('"error":"invalid_request"'),
      `expected the sanitized code in the payload: ${response.body}`,
    )
    await app.close()
  })
})

test('callback keeps the JSON error contract for non-browser callers', async () => {
  await withAdminOrigin('https://admin.example.test', async () => {
    const app = makeApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/mcp/oauth/callback?error=access_denied',
    })
    assert.equal(response.statusCode, 400)
    const body = JSON.parse(response.body) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'MCP_OAUTH_PROVIDER_ERROR')
    assert.equal(response.body.includes('postMessage'), false)
    await app.close()
  })
})

/**
 * Phase 5 — the OAuth Client ID Metadata Document.
 *
 * Its whole job is to be fetched by an authorization server and believed, so
 * the two properties that matter are that `client_id` is this document's own
 * URL and that every value in it came from operator config rather than from
 * the fetching request.
 */

const makeWellKnownApp = (config: Record<string, unknown>) => {
  const app = Fastify({ logger: false })
  registerWellKnownOAuthClientRoutes(
    app,
    { config } as unknown as Parameters<typeof registerWellKnownOAuthClientRoutes>[1],
  )
  return app
}

test('CIMD document is self-addressed and declares the real callback URI', async () => {
  await withAdminOrigin(null, async () => {
    const app = makeWellKnownApp({
      mode: 'selfHosted',
      api: { publicUrl: 'https://api.example.test' },
    })
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-client' })
    assert.equal(response.statusCode, 200)
    const doc = JSON.parse(response.body) as Record<string, unknown>
    assert.equal(doc['client_id'], 'https://api.example.test/.well-known/oauth-client')
    assert.equal(doc['client_name'], 'Nessie')
    assert.deepEqual(doc['redirect_uris'], [
      'https://api.example.test/api/mcp/oauth/callback',
    ])
    assert.deepEqual(doc['grant_types'], ['authorization_code', 'refresh_token'])
    assert.deepEqual(doc['response_types'], ['code'])
    assert.equal(doc['token_endpoint_auth_method'], 'none')
    // A public client has no secret; the document must never grow one.
    assert.equal('client_secret' in doc, false)
    // No admin origin configured ⇒ no `client_uri` at all, rather than a
    // consent-screen link pointing at an API host nobody visits.
    assert.equal('client_uri' in doc, false)
    await app.close()
  })
})

test('CIMD document ignores Host / X-Forwarded-Host and names the admin origin', async () => {
  await withAdminOrigin('https://app.example.test', async () => {
    const app = makeWellKnownApp({
      mode: 'selfHosted',
      api: { publicUrl: 'https://api.example.test' },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-client',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(
      response.body.includes('evil.example'),
      false,
      `request input reached the document: ${response.body}`,
    )
    const doc = JSON.parse(response.body) as Record<string, unknown>
    // `buildClientIdMetadataDocument` normalises through `URL`, which is why
    // the published value carries the root path.
    assert.equal(doc['client_uri'], 'https://app.example.test/')
    await app.close()
  })
})

test('CIMD document refuses to publish a guessed origin', async () => {
  const app = makeWellKnownApp({ mode: 'selfHosted', api: {} })
  const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-client' })
  assert.equal(response.statusCode, 500)
  const body = JSON.parse(response.body) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'PUBLIC_ORIGIN_NOT_CONFIGURED')
  await app.close()
})
