import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isCredentialHeaderName,
  normalizeFetchHeaders,
  resolveRedirectPolicy,
} from '../src/redirect-policy.js'
import { safeFetch, UrlSafetyError } from '../src/url-safety.js'

const publicResolve = async () => ['93.184.216.34']

// A recording transport stands in for the dial: it proves exactly which hops
// were attempted and with which method/headers/body, without a live host.
const recordingTransport = (
  responder: (url: URL) => { status: number; location?: string; body?: string },
) => {
  const calls: Array<{
    body: unknown
    headers: Record<string, string>
    method: string
    url: string
  }> = []
  const fetchImpl = async (url: URL, init?: RequestInit): Promise<Response> => {
    const result = responder(url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    calls.push({
      body: init?.body ?? null,
      headers,
      method: (init?.method ?? 'GET').toUpperCase(),
      url: url.toString(),
    })
    return new Response(result.body ?? '', {
      status: result.status,
      headers: result.location ? { location: result.location } : {},
    })
  }
  return { calls, fetchImpl }
}

const crossOrigin302 = (url: URL): { status: number; location?: string; body?: string } =>
  url.pathname === '/start'
    ? { status: 302, location: 'http://other.test/end' }
    : { status: 200, body: 'arrived' }

describe('normalizeFetchHeaders', () => {
  it('lowercases a Headers instance', () => {
    const headers = normalizeFetchHeaders(undefined, {
      headers: new Headers({ 'X-API-Key': 'k', 'Content-Type': 'text/plain' }),
    })
    assert.equal(headers.get('x-api-key'), 'k')
    assert.equal(headers.get('content-type'), 'text/plain')
  })

  it('lowercases [name, value] pairs', () => {
    const headers = normalizeFetchHeaders(undefined, {
      headers: [['Authorization', 'Bearer t']],
    })
    assert.equal(headers.get('authorization'), 'Bearer t')
  })

  it('lowercases a plain record', () => {
    const headers = normalizeFetchHeaders(undefined, {
      headers: { Cookie: 'session=1' },
    })
    assert.equal(headers.get('cookie'), 'session=1')
  })

  it('merges Request input headers UNDER explicit init headers', () => {
    const input = new Request('http://public.test/x', {
      headers: { 'X-Api-Key': 'from-request', 'X-Trace': 'trace-1' },
    })
    const headers = normalizeFetchHeaders(input, {
      headers: { 'x-api-key': 'from-init' },
    })
    // fetch(input, init) semantics: init wins on conflict, the Request
    // contributes what init does not set.
    assert.equal(headers.get('x-api-key'), 'from-init')
    assert.equal(headers.get('x-trace'), 'trace-1')
  })
})

describe('resolveRedirectPolicy', () => {
  it('recognizes every credential-shaped name', () => {
    for (const name of [
      'authorization',
      'cookie',
      'proxy-authorization',
      'x-api-key',
      'x-nessie-context',
      'x-uoa-delegation',
    ]) {
      assert.equal(resolveRedirectPolicy(undefined, new Map([[name, 'v']])), 'same-origin')
      assert.ok(isCredentialHeaderName(name))
    }
  })

  it('honours the typed credentialsPresent flag for arbitrary header names', () => {
    const headers = new Map([['x-custom-auth', 'v']])
    assert.equal(resolveRedirectPolicy({ credentialsPresent: true }, headers), 'same-origin')
    assert.equal(resolveRedirectPolicy(undefined, headers), 'follow')
  })

  it('lets an explicit option win over every default', () => {
    const headers = new Map([['authorization', 'Bearer t']])
    assert.equal(resolveRedirectPolicy({ redirectPolicy: 'follow' }, headers), 'follow')
    assert.equal(resolveRedirectPolicy({ redirectPolicy: 'none' }, headers), 'none')
  })

  it('treats maxRedirects: 0 as equivalent to none', () => {
    assert.equal(resolveRedirectPolicy({ maxRedirects: 0 }, new Map()), 'none')
  })
})

describe('safeFetch redirect policy', () => {
  it('defaults credentialed requests to same-origin and refuses a cross-origin 302, naming both origins', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    await assert.rejects(
      safeFetch(
        'http://public.test/start',
        { headers: { Authorization: 'Bearer secret' } },
        { fetchImpl, resolveHost: publicResolve },
      ),
      (error: unknown) =>
        error instanceof UrlSafetyError &&
        error.message.includes('http://public.test') &&
        error.message.includes('http://other.test'),
    )
    assert.deepEqual(
      calls.map((call) => call.url),
      ['http://public.test/start'],
      'the cross-origin hop must never be dialled',
    )
  })

  for (const [label, headers] of [
    ['Headers instance', () => new Headers({ 'X-Api-Key': 'k' })] as const,
    ['pairs', () => [['X-Api-Key', 'k']] as string[][]] as const,
    ['record', () => ({ 'X-Api-Key': 'k' })] as const,
  ]) {
    it(`classifies credentials from ${label}`, async () => {
      const { calls, fetchImpl } = recordingTransport(crossOrigin302)
      await assert.rejects(
        safeFetch(
          'http://public.test/start',
          { headers: headers() as HeadersInit },
          { fetchImpl, resolveHost: publicResolve },
        ),
        UrlSafetyError,
      )
      assert.equal(calls.length, 1)
    })
  }

  it('classifies credentials carried only by the Request input', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    await assert.rejects(
      safeFetch(new Request('http://public.test/start', { headers: { Cookie: 's=1' } }), undefined, {
        fetchImpl,
        resolveHost: publicResolve,
      }),
      UrlSafetyError,
    )
    assert.equal(calls.length, 1)
  })

  it('sends the merged Request + init headers on the wire', async () => {
    const { calls, fetchImpl } = recordingTransport(() => ({ status: 200, body: 'ok' }))
    await safeFetch(
      new Request('http://public.test/x', { headers: { 'X-Trace': 't1', 'X-Api-Key': 'from-request' } }),
      { headers: { 'X-Api-Key': 'from-init' } },
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(calls[0]?.headers['x-trace'], 't1')
    assert.equal(calls[0]?.headers['x-api-key'], 'from-init')
  })

  it('follows a same-origin hop with credentials intact under the credentialed default', async () => {
    const { calls, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start' ? { status: 302, location: '/end' } : { status: 200, body: 'arrived' },
    )
    const response = await safeFetch(
      'http://public.test/start',
      { headers: { authorization: 'Bearer secret' } },
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(await response.text(), 'arrived')
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.headers.authorization, 'Bearer secret')
  })

  it('returns the raw 3xx under redirectPolicy: none', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    const response = await safeFetch(
      'http://public.test/start',
      {},
      { fetchImpl, redirectPolicy: 'none', resolveHost: publicResolve },
    )
    assert.equal(response.status, 302)
    assert.equal(calls.length, 1)
  })

  it('keeps maxRedirects: 0 equivalent to none', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    const response = await safeFetch(
      'http://public.test/start',
      { headers: { authorization: 'Bearer t' } },
      { fetchImpl, maxRedirects: 0, resolveHost: publicResolve },
    )
    assert.equal(response.status, 302)
    assert.equal(calls.length, 1)
  })

  it('follows cross-origin under explicit follow, stripping credential-shaped headers', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    const response = await safeFetch(
      'http://public.test/start',
      { headers: { Authorization: 'Bearer secret', Cookie: 's=1', 'X-Trace': 'keep-me' } },
      { fetchImpl, redirectPolicy: 'follow', resolveHost: publicResolve },
    )
    assert.equal(await response.text(), 'arrived')
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.headers.authorization, 'Bearer secret')
    assert.equal(calls[1]?.headers.authorization, undefined)
    assert.equal(calls[1]?.headers.cookie, undefined)
    assert.equal(calls[1]?.headers['x-trace'], 'keep-me')
  })

  it('cannot spot a credential under a caller-chosen name, so stripping covers the shaped names only', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    await safeFetch(
      'http://public.test/start',
      { headers: { 'X-Api-Key': 'k', 'X-Custom-Auth': 'opaque' } },
      { credentialsPresent: true, fetchImpl, redirectPolicy: 'follow', resolveHost: publicResolve },
    )
    assert.equal(calls[1]?.headers['x-api-key'], undefined)
    // This leak is the SB-05 trap the typed flag exists to prevent: callers
    // with a credential under an arbitrary name must rely on the default
    // 'same-origin' policy (or pin 'none'), never on cross-origin stripping.
    assert.equal(calls[1]?.headers['x-custom-auth'], 'opaque')
  })

  it('refuses a cross-origin 307 with a body even under explicit follow', async () => {
    const { calls, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start'
        ? { status: 307, location: 'http://other.test/end' }
        : { status: 200, body: 'arrived' },
    )
    await assert.rejects(
      safeFetch(
        'http://public.test/start',
        { body: 'payload', method: 'POST' },
        { fetchImpl, redirectPolicy: 'follow', resolveHost: publicResolve },
      ),
      (error: unknown) =>
        error instanceof UrlSafetyError &&
        error.message.includes('http://public.test') &&
        error.message.includes('http://other.test') &&
        error.message.includes('307'),
    )
    assert.equal(calls.length, 1)
  })

  it('replays the body on a same-origin 307', async () => {
    const { calls, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start' ? { status: 307, location: '/end' } : { status: 200, body: 'arrived' },
    )
    const response = await safeFetch(
      'http://public.test/start',
      { body: 'payload', headers: { 'content-type': 'text/plain' }, method: 'POST' },
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(await response.text(), 'arrived')
    assert.equal(calls[1]?.method, 'POST')
    assert.equal(calls[1]?.body, 'payload')
  })

  it('converts a 303 to GET and drops the body', async () => {
    const { calls, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start'
        ? { status: 303, location: 'http://other.test/end' }
        : { status: 200, body: 'arrived' },
    )
    const response = await safeFetch(
      'http://public.test/start',
      { body: 'payload', headers: { 'content-type': 'text/plain' }, method: 'POST' },
      { fetchImpl, redirectPolicy: 'follow', resolveHost: publicResolve },
    )
    assert.equal(await response.text(), 'arrived')
    assert.equal(calls[1]?.method, 'GET')
    assert.equal(calls[1]?.body, null)
    assert.equal(calls[1]?.headers['content-type'], undefined)
  })

  it('follows cross-origin redirects unchanged for uncredentialed requests', async () => {
    const { calls, fetchImpl } = recordingTransport(crossOrigin302)
    const response = await safeFetch(
      'http://public.test/start',
      { headers: { 'X-Trace': 'trace-1' } },
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(await response.text(), 'arrived')
    assert.equal(calls.length, 2)
    // No credential-shaped names, so nothing is stripped.
    assert.equal(calls[1]?.headers['x-trace'], 'trace-1')
  })
})
