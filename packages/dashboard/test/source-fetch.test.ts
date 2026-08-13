import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASHBOARD_MAX_RESPONSE_BYTES,
  DashboardFetchError,
  buildSourceUrl,
  fetchDashboardSource,
  type DashboardEgressPolicy,
} from '../src/source-fetch.js'

const policy: DashboardEgressPolicy = {
  deniedOrigins: ['https://api.nessie.works', 'https://app.nessie.works'],
}

const base = { origin: 'https://status.example.com', path: '/v1/metrics' }

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })

test('builds an https URL and applies literal query params', () => {
  const url = buildSourceUrl({ ...base, queryParams: { window: '24h', limit: 10 } }, policy)
  assert.equal(url.origin, 'https://status.example.com')
  assert.equal(url.pathname, '/v1/metrics')
  assert.equal(url.searchParams.get('window'), '24h')
  assert.equal(url.searchParams.get('limit'), '10')
})

test('refuses plain http', () => {
  assert.throws(
    () => buildSourceUrl({ origin: 'http://status.example.com', path: '/' }, policy),
    (error: DashboardFetchError) => error.code === 'SOURCE_URL_REJECTED',
  )
})

test('refuses credentials embedded in the URL', () => {
  assert.throws(
    () => buildSourceUrl({ origin: 'https://user:pw@status.example.com', path: '/' }, policy),
    (error: DashboardFetchError) => error.code === 'SOURCE_URL_REJECTED',
  )
})

test("refuses this deployment's own origin even though it is publicly routable", () => {
  assert.throws(
    () => buildSourceUrl({ origin: 'https://api.nessie.works', path: '/api/runs' }, policy),
    (error: DashboardFetchError) => error.code === 'SOURCE_URL_REJECTED',
  )
})

test('strips a fragment rather than sending it', () => {
  const url = buildSourceUrl({ origin: 'https://status.example.com/#secret', path: '/x' }, policy)
  assert.equal(url.hash, '')
})

test('sends identity encoding and a JSON accept header, and no cookie', async () => {
  let seen: Headers | undefined
  await fetchDashboardSource(base, policy, {
    fetchImpl: (async (_url, init) => {
      seen = new Headers(init?.headers)
      return jsonResponse([])
    }) as never,
  })
  assert.equal(seen?.get('accept-encoding'), 'identity')
  assert.equal(seen?.get('accept'), 'application/json')
  assert.equal(seen?.get('cookie'), null)
})

test('attaches a bearer credential', async () => {
  let seen: Headers | undefined
  await fetchDashboardSource(
    { ...base, credential: { mode: 'bearer', value: 'sk-live-abc' } },
    policy,
    {
      fetchImpl: (async (_url, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse([])
      }) as never,
    },
  )
  assert.equal(seen?.get('authorization'), 'Bearer sk-live-abc')
})

test('refuses a credential placed in a forwarding or identity header', async () => {
  for (const headerName of ['x-forwarded-for', 'cookie', 'x-nessie-context', 'host']) {
    await assert.rejects(
      fetchDashboardSource(
        { ...base, credential: { mode: 'header', headerName, value: 'v' } },
        policy,
        { fetchImpl: (async () => jsonResponse([])) as never },
      ),
      (error: DashboardFetchError) => error.code === 'SOURCE_URL_REJECTED',
    )
  }
})

test('never follows a redirect — a credential must not reach the next hop', async () => {
  let calls = 0
  await assert.rejects(
    fetchDashboardSource(
      { ...base, credential: { mode: 'bearer', value: 'sk-live-abc' } },
      policy,
      {
        fetchImpl: (async (_url, _init, options) => {
          calls += 1
          assert.equal(options?.maxRedirects, 0)
          return new Response(null, {
            status: 302,
            headers: { location: 'https://attacker.example.com/collect' },
          })
        }) as never,
      },
    ),
    (error: DashboardFetchError) => error.code === 'SOURCE_REDIRECTED',
  )
  assert.equal(calls, 1)
})

test('rejects a compressed response instead of decompressing it', async () => {
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        })) as never,
    }),
    (error: DashboardFetchError) => error.code === 'SOURCE_RESPONSE_ENCODED',
  )
})

test('rejects an oversized response declared by content-length', async () => {
  // Only the rejection is asserted here. "Without buffering it" cannot be
  // observed through undici, which touches the stream while wrapping it in a
  // Response — the streaming byte counter is covered by the next test, which
  // is the case that actually matters (a dishonest or absent length).
  let chunksPulled = 0
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () => {
        const stream = new ReadableStream({
          pull(controller) {
            chunksPulled += 1
            controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(DASHBOARD_MAX_RESPONSE_BYTES + 1),
          },
        })
      }) as never,
    }),
    (error: DashboardFetchError) => error.code === 'SOURCE_RESPONSE_TOO_LARGE',
  )
  // It short-circuits on the declared length rather than draining the body.
  assert.ok(chunksPulled <= 1, `expected an early exit, pulled ${chunksPulled} chunks`)
})

test('caps a dishonest response that lies about its length', async () => {
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () => {
        const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
        let sent = 0
        const stream = new ReadableStream({
          pull(controller) {
            sent += 1
            if (sent > 40) {
              controller.close()
              return
            }
            controller.enqueue(chunk)
          },
        })
        // No content-length at all: the streaming counter is the only defence.
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as never,
    }),
    (error: DashboardFetchError) => error.code === 'SOURCE_RESPONSE_TOO_LARGE',
  )
})

test('rejects a non-JSON content type', async () => {
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () =>
        new Response('<html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as never,
    }),
    (error: DashboardFetchError) => error.code === 'SOURCE_NOT_JSON',
  )
})

test('accepts an application/*+json content type', async () => {
  const outcome = await fetchDashboardSource(base, policy, {
    fetchImpl: (async () =>
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' },
      })) as never,
  })
  assert.equal(outcome.status, 'ok')
})

test('maps 401 and 403 to an auth code, not a generic HTTP error', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(
      fetchDashboardSource(base, policy, {
        fetchImpl: (async () => new Response('nope', { status })) as never,
      }),
      (error: DashboardFetchError) => error.code === 'SOURCE_AUTH_REJECTED',
    )
  }
})

test('never puts the response body into the error', async () => {
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () =>
        new Response('{"secret":"leaked-token-value"', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as never,
    }),
    (error: DashboardFetchError) => {
      assert.equal(error.code, 'SOURCE_INVALID_JSON')
      const text = `${error.message}${error.detail ?? ''}`
      assert.equal(text.includes('leaked-token-value'), false)
      return true
    },
  )
})

test('rejects an absurdly nested document', async () => {
  let nested: unknown = 'leaf'
  for (let depth = 0; depth < 40; depth += 1) nested = { nested }
  await assert.rejects(
    fetchDashboardSource(base, policy, {
      fetchImpl: (async () => jsonResponse(nested)) as never,
    }),
    (error: DashboardFetchError) => error.code === 'SOURCE_INVALID_JSON',
  )
})

test('passes a 304 straight through as not_modified', async () => {
  const outcome = await fetchDashboardSource({ ...base, etag: 'W/"abc"' }, policy, {
    fetchImpl: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('if-none-match'), 'W/"abc"')
      return new Response(null, { status: 304 })
    }) as never,
  })
  assert.equal(outcome.status, 'not_modified')
})
