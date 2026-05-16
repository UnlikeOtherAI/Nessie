import assert from 'node:assert/strict'
import test from 'node:test'

import { HttpFetchError, runHttpFetch } from './http-fetch.js'
import type { ResolveHost } from './url-safety.js'

type FetchCall = {
  url: string
  init: RequestInit
}

const makeFakeFetch = (
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const initObj: RequestInit = init ?? {}
    calls.push({ url, init: initObj })
    return responder(url, initObj)
  }
  return { fetchImpl, calls }
}

/**
 * Build a fake DNS resolver from a fixed hostname → addresses map. Tests use
 * this to keep the SSRF suite hermetic — no real DNS is ever called.
 */
const makeFakeResolver = (
  table: Record<string, readonly string[]>,
): ResolveHost => async (hostname) => {
  const lower = hostname.toLowerCase()
  const addrs = table[lower]
  if (!addrs) {
    throw new Error(`unexpected DNS lookup in test: ${hostname}`)
  }
  return [...addrs]
}

/**
 * Resolver that returns different answers across successive calls — models a
 * DNS-rebinding attacker who returns a public IP on first lookup (used by the
 * SSRF guard) and a private IP on the second.
 */
const makeSequencedResolver = (
  hostname: string,
  sequence: readonly string[],
): ResolveHost => {
  let i = 0
  return async (host) => {
    if (host.toLowerCase() !== hostname.toLowerCase()) {
      throw new Error(`unexpected DNS lookup in test: ${host}`)
    }
    const idx = Math.min(i, sequence.length - 1)
    i += 1
    const addr = sequence[idx]!
    return [addr]
  }
}

const publicResolver = makeFakeResolver({
  'example.com': ['93.184.216.34'],
})

test('runHttpFetch returns body and headers on happy GET', async () => {
  const { fetchImpl } = makeFakeFetch(() =>
    new Response('hello world', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
    }),
  )

  const result = await runHttpFetch(
    { url: 'https://example.com/data' },
    { fetchImpl, resolveHost: publicResolver },
  )

  assert.equal(result.status, 200)
  assert.equal(result.statusText, 'OK')
  assert.equal(result.bodyText, 'hello world')
  assert.equal(result.truncated, false)
  assert.equal(result.headers['content-type'], 'text/plain')
})

test('runHttpFetch encodes object body as JSON and sets content-type', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('{}', { status: 200 }))

  await runHttpFetch(
    {
      method: 'POST',
      url: 'https://example.com/api',
      body: { hello: 'world' },
    },
    { fetchImpl, resolveHost: publicResolver },
  )

  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.body, JSON.stringify({ hello: 'world' }))
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
})

test('runHttpFetch caps response body when maxBytes exceeded', async () => {
  const bigBody = 'x'.repeat(2000)
  const { fetchImpl } = makeFakeFetch(() => new Response(bigBody, { status: 200 }))

  const result = await runHttpFetch(
    { url: 'https://example.com', maxBytes: 100 },
    { fetchImpl, resolveHost: publicResolver },
  )

  assert.equal(result.truncated, true)
  assert.equal(result.bytesRead, 100)
  assert.equal(result.bodyText.length, 100)
})

test('runHttpFetch refuses redirects to file:// URLs', async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response('', {
      status: 302,
      headers: { location: 'file:///etc/passwd' },
    })

  await assert.rejects(
    runHttpFetch(
      { url: 'https://example.com' },
      { fetchImpl, resolveHost: publicResolver },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Unsupported URL scheme/.test(err.message),
  )
})

test('runHttpFetch refuses a file:// URL at the initial request', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response(''))

  await assert.rejects(
    runHttpFetch(
      { url: 'file:///etc/passwd' },
      { fetchImpl, resolveHost: publicResolver },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Unsupported URL scheme/.test(err.message),
  )
  assert.equal(calls.length, 0)
})

test('runHttpFetch refuses requests to localhost', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response(''))

  await assert.rejects(
    runHttpFetch(
      { url: 'http://localhost:5554/whatever' },
      {
        fetchImpl,
        resolveHost: makeFakeResolver({ localhost: ['127.0.0.1'] }),
      },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Private or local network/.test(err.message),
  )
  assert.equal(calls.length, 0)
})

test('runHttpFetch refuses requests to the cloud metadata IP', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response(''))

  // 169.254.169.254 is a literal IP — no DNS lookup is performed, but we
  // still pass an injected resolver to keep the suite hermetic if the guard
  // ever changes shape.
  await assert.rejects(
    runHttpFetch(
      { url: 'http://169.254.169.254/latest/meta-data/' },
      {
        fetchImpl,
        resolveHost: makeFakeResolver({
          'metadata.google.internal': ['169.254.169.254'],
        }),
      },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Private or local network/.test(err.message),
  )
  assert.equal(calls.length, 0)
})

test('runHttpFetch refuses a redirect to a private IPv4 address', async () => {
  let serverHits = 0
  const fetchImpl: typeof fetch = async (input) => {
    serverHits += 1
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('https://example.com')) {
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      })
    }
    return new Response('should-not-be-reached', { status: 200 })
  }

  await assert.rejects(
    runHttpFetch(
      { url: 'https://example.com' },
      { fetchImpl, resolveHost: publicResolver },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Private or local network/.test(err.message),
  )
  assert.equal(serverHits, 1)
})

test('runHttpFetch refuses URLs that embed credentials', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response(''))

  await assert.rejects(
    runHttpFetch(
      { url: 'https://user:pass@example.com/data' },
      { fetchImpl, resolveHost: publicResolver },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Authenticated URLs/.test(err.message),
  )
  assert.equal(calls.length, 0)
})

test('runHttpFetch injects bearer auth header by default', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))

  await runHttpFetch(
    {
      url: 'https://example.com',
      auth: { kind: 'bearer', token: 'sekret' },
    },
    { fetchImpl, resolveHost: publicResolver },
  )

  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sekret')
})

test('runHttpFetch supports apiKey auth with custom header + prefix', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response('', { status: 200 }))

  await runHttpFetch(
    {
      url: 'https://example.com',
      auth: {
        kind: 'apiKey',
        headerName: 'X-Vendor-Token',
        valuePrefix: 'Token ',
        token: 'abc123',
      },
    },
    { fetchImpl, resolveHost: publicResolver },
  )

  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers['X-Vendor-Token'], 'Token abc123')
})

test('runHttpFetch enforces timeoutMs by aborting the request', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal
    return new Promise<Response>((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new Error('aborted'))
        })
      }
      // never resolves on its own
      setTimeout(() => resolve(new Response('late')), 5_000).unref?.()
    })
  }

  await assert.rejects(
    runHttpFetch(
      { url: 'https://example.com', timeoutMs: 5 },
      { fetchImpl, resolveHost: publicResolver },
    ),
  )
})

test('runHttpFetch rejects a public hostname whose DNS resolves to a private IP', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => new Response(''))

  await assert.rejects(
    runHttpFetch(
      { url: 'https://attacker.example' },
      {
        fetchImpl,
        resolveHost: makeFakeResolver({ 'attacker.example': ['10.0.0.5'] }),
      },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Private or local network/.test(err.message),
  )
  assert.equal(calls.length, 0)
})

test('runHttpFetch allows a public hostname whose DNS resolves to a public IP', async () => {
  const { fetchImpl, calls } = makeFakeFetch(() =>
    new Response('ok', { status: 200 }),
  )

  const result = await runHttpFetch(
    { url: 'https://safe.example' },
    {
      fetchImpl,
      resolveHost: makeFakeResolver({ 'safe.example': ['1.2.3.4'] }),
    },
  )

  assert.equal(result.status, 200)
  assert.equal(result.bodyText, 'ok')
  assert.equal(calls.length, 1)
})

test('runHttpFetch re-checks DNS on redirect, catching rebinding', async () => {
  // First lookup (initial URL) returns a public IP; second lookup (redirect
  // target — same hostname) returns a private IP. The redirect must be
  // rejected. Models a DNS-rebinding attacker.
  let serverHits = 0
  const fetchImpl: typeof fetch = async (input) => {
    serverHits += 1
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('https://rebind.example')) {
      return new Response('', {
        status: 302,
        headers: { location: 'https://rebind.example/redirected' },
      })
    }
    return new Response('should-not-be-reached', { status: 200 })
  }

  await assert.rejects(
    runHttpFetch(
      { url: 'https://rebind.example' },
      {
        fetchImpl,
        resolveHost: makeSequencedResolver('rebind.example', [
          '1.2.3.4',
          '127.0.0.1',
        ]),
      },
    ),
    (err) =>
      err instanceof HttpFetchError &&
      /Private or local network/.test(err.message),
  )
  assert.equal(serverHits, 1)
})
