import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { after, describe, it } from 'node:test'

import {
  assertSafeUrlPinned,
  createPinnedFetchAgent,
  pinnedConnect,
  safeFetch,
  UrlSafetyError,
} from '../src/url-safety.js'

// A loopback origin stands in for "an internal address a rebinding attack would
// reach". The guard blocks 127.0.0.1 by policy, so tests that need the server to
// answer resolve a public-looking hostname to it explicitly.
const startServer = (
  handler: (path: string) => { status: number; headers?: Record<string, string>; body?: string },
): Promise<{ close: () => Promise<void>; port: number; server: Server }> =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const result = handler(request.url ?? '/')
      response.writeHead(result.status, result.headers ?? {})
      response.end(result.body ?? '')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
        port,
        server,
      })
    })
  })

describe('assertSafeUrlPinned', () => {
  it('returns the literal IP for an address-form URL', async () => {
    const { addresses, url } = await assertSafeUrlPinned('https://93.184.216.34/x')
    assert.deepEqual(addresses, ['93.184.216.34'])
    assert.equal(url.hostname, '93.184.216.34')
  })

  it('returns every resolved address for a hostname', async () => {
    const { addresses } = await assertSafeUrlPinned('https://example.test/x', {
      resolveHost: async () => ['93.184.216.34', '93.184.216.35'],
    })
    assert.deepEqual(addresses, ['93.184.216.34', '93.184.216.35'])
  })

  it('rejects a hostname that resolves to a private address', async () => {
    await assert.rejects(
      assertSafeUrlPinned('https://rebind.test/x', {
        resolveHost: async () => ['10.0.0.5'],
      }),
      UrlSafetyError,
    )
  })

  it('rejects when only one of several addresses is private', async () => {
    await assert.rejects(
      assertSafeUrlPinned('https://rebind.test/x', {
        resolveHost: async () => ['93.184.216.34', '169.254.169.254'],
      }),
      UrlSafetyError,
    )
  })
})

describe('createPinnedFetchAgent', () => {
  // A reachable loopback server is exactly what a successful rebind would land
  // on. The pinned dispatcher re-checks each address as it dials, so even when
  // the socket would connect, it must refuse — and the server must see nothing.
  it('refuses a pinned private address even when a server is listening there', async () => {
    let hits = 0
    const server = await startServer(() => {
      hits += 1
      return { status: 200, body: 'reached' }
    })
    after(() => server.close())

    const agent = createPinnedFetchAgent(['127.0.0.1'])
    await assert.rejects(
      fetch(`http://public.test:${server.port}/`, {
        dispatcher: agent,
      } as RequestInit & { dispatcher: unknown }),
    )
    await agent.close()
    assert.equal(hits, 0, 'the loopback server must never be reached')
  })

  it('refuses when every pinned address is private', async () => {
    const agent = createPinnedFetchAgent(['10.0.0.5'])
    await assert.rejects(
      fetch('http://example.test/', {
        dispatcher: agent,
      } as RequestInit & { dispatcher: unknown }),
    )
    await agent.close()
  })
})

describe('pinnedConnect', () => {
  it('passes only the vetted literal address to the raw socket connector', async () => {
    let attempted: { address: string; port: number } | undefined
    const socket = { destroy: () => undefined } as unknown as import('node:net').Socket
    const connected = await pinnedConnect('https://public.test/path', {
      connectImpl: async (input) => {
        attempted = input
        return socket
      },
      resolveHost: async () => ['93.184.216.34'],
    })
    assert.equal(connected.socket, socket)
    assert.deepEqual(attempted, { address: '93.184.216.34', port: 443 })
  })

  it('rejects a private target before the raw connector runs', async () => {
    let attempts = 0
    await assert.rejects(
      pinnedConnect('https://rebind.test/path', {
        connectImpl: async () => {
          attempts += 1
          throw new Error('must not connect')
        },
        resolveHost: async () => ['127.0.0.1'],
      }),
      UrlSafetyError,
    )
    assert.equal(attempts, 0)
  })

  it('rejects HTTP before the raw connector runs', async () => {
    let attempts = 0
    await assert.rejects(
      pinnedConnect('http://public.test/path', {
        connectImpl: async () => {
          attempts += 1
          throw new Error('must not connect')
        },
        resolveHost: async () => ['93.184.216.34'],
      }),
      UrlSafetyError,
    )
    assert.equal(attempts, 0)
  })
})

describe('safeFetch', () => {
  // Every hop is validated before it is dialled, so the transport only ever sees
  // URLs that passed the guard. Recording them proves which hops were attempted.
  const recordingTransport = (
    responder: (url: URL) => { status: number; location?: string; body?: string },
  ) => {
    const dialled: string[] = []
    const fetchImpl = async (url: URL): Promise<Response> => {
      dialled.push(url.toString())
      const result = responder(url)
      return new Response(result.body ?? '', {
        status: result.status,
        headers: result.location ? { location: result.location } : {},
      })
    }
    return { dialled, fetchImpl }
  }

  const publicResolve = async () => ['93.184.216.34']

  it('rejects a private URL before issuing any request', async () => {
    const { dialled, fetchImpl } = recordingTransport(() => ({ status: 200 }))
    await assert.rejects(safeFetch('http://127.0.0.1:1/', {}, { fetchImpl }), UrlSafetyError)
    assert.deepEqual(dialled, [])
  })

  it('rejects a hostname that resolves to a private address without dialling', async () => {
    const { dialled, fetchImpl } = recordingTransport(() => ({ status: 200 }))
    await assert.rejects(
      safeFetch('http://rebind.test/', {}, { fetchImpl, resolveHost: async () => ['10.0.0.5'] }),
      UrlSafetyError,
    )
    assert.deepEqual(dialled, [])
  })

  it('re-validates a redirect hop and refuses a private destination', async () => {
    const { dialled, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start'
        ? { status: 302, location: 'http://169.254.169.254/latest/meta-data' }
        : { status: 200, body: 'should not be reachable' },
    )

    await assert.rejects(
      safeFetch('http://public.test/start', {}, { fetchImpl, resolveHost: publicResolve }),
      UrlSafetyError,
    )
    // The metadata endpoint must never have been dialled.
    assert.deepEqual(dialled, ['http://public.test/start'])
  })

  it('follows a redirect that stays on a validated host', async () => {
    const { dialled, fetchImpl } = recordingTransport((url) =>
      url.pathname === '/start'
        ? { status: 302, location: '/end' }
        : { status: 200, body: 'arrived' },
    )

    const response = await safeFetch(
      'http://public.test/start',
      {},
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'arrived')
    assert.deepEqual(dialled, ['http://public.test/start', 'http://public.test/end'])
  })

  it('gives up after the redirect budget', async () => {
    const { dialled, fetchImpl } = recordingTransport(() => ({
      status: 302,
      location: '/loop',
    }))

    await assert.rejects(
      safeFetch(
        'http://public.test/loop',
        {},
        { fetchImpl, maxRedirects: 2, resolveHost: publicResolve },
      ),
      (error: unknown) =>
        error instanceof UrlSafetyError && error.message === 'Too many redirects.',
    )
    assert.equal(dialled.length, 3)
  })

  it('passes a pinned dispatcher to the transport on every hop', async () => {
    const dispatchers: unknown[] = []
    const fetchImpl = async (_url: URL, init: { dispatcher?: unknown }): Promise<Response> => {
      dispatchers.push(init.dispatcher)
      return new Response('ok', { status: 200 })
    }

    await safeFetch('http://public.test/x', {}, { fetchImpl, resolveHost: publicResolve })
    assert.equal(dispatchers.length, 1)
    assert.ok(dispatchers[0], 'expected a pinned dispatcher on the request')
  })

  it('forces redirect:manual so the platform never chases a hop unvalidated', async () => {
    let seenRedirectMode: RequestRedirect | undefined
    const fetchImpl = async (_url: URL, init: RequestInit): Promise<Response> => {
      seenRedirectMode = init.redirect
      return new Response('ok', { status: 200 })
    }

    await safeFetch(
      'http://public.test/x',
      { redirect: 'follow' },
      { fetchImpl, resolveHost: publicResolve },
    )
    assert.equal(seenRedirectMode, 'manual')
  })
})
