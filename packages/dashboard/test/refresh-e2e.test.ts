/**
 * The fetch → normalize path against a REAL HTTPS server.
 *
 * Every other test stubs `safeFetch`. This one stands up a self-signed TLS
 * server on loopback and drives the actual egress code, so the parts that only
 * exist at the socket layer — TLS, the streaming body reader, real headers,
 * a genuine 304 — are exercised rather than mocked.
 *
 * Loopback is normally refused by the SSRF guard, which is the point: the guard
 * is doing its job. The test injects a `fetchImpl` that skips only the IP
 * pinning while keeping every other control (redirect policy, encoding
 * rejection, size caps, content-type pinning, JSON depth) on the real code
 * path.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { fetchDashboardSource, type DashboardEgressPolicy } from '../src/source-fetch.js'
import { normalizeDashboardDocument } from '../src/normalize.js'

// A throwaway self-signed certificate, generated once for this suite.
const { generateKeyPairSync, X509Certificate } = await import('node:crypto')

let server: https.Server
let origin: string
let lastHeaders: Record<string, string | string[] | undefined> = {}
let mode: 'ok' | 'etag' | 'huge' | 'html' = 'ok'

const payload = {
  points: [
    { t: '2026-08-13T10:00:00Z', ok: 120, note: 'first' },
    { t: '2026-08-13T11:00:00Z', ok: 138, note: 'second' },
  ],
}

const policy: DashboardEgressPolicy = { deniedOrigins: [] }

const columns = [
  { key: 't', label: 'Time', type: 'datetime' as const, nullable: false },
  { key: 'ok', label: 'OK', type: 'number' as const, nullable: false },
  { key: 'note', label: 'Note', type: 'string' as const, nullable: true },
]

before(async () => {
  const selfsigned = await import('node:child_process')
  // openssl is present on macOS and every CI image used here.
  const key = '/tmp/nessie-dash-test-key.pem'
  const cert = '/tmp/nessie-dash-test-cert.pem'
  selfsigned.execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })

  const fs = await import('node:fs')
  server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (request, response) => {
      lastHeaders = request.headers
      if (mode === 'html') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html></html>')
        return
      }
      if (mode === 'huge') {
        response.writeHead(200, { 'content-type': 'application/json' })
        // 4 MiB, well past the 1 MiB cap, streamed without a content-length.
        const chunk = 'x'.repeat(64 * 1024)
        for (let index = 0; index < 64; index += 1) response.write(`"${chunk}"`)
        response.end()
        return
      }
      if (mode === 'etag' && request.headers['if-none-match'] === 'W/"v1"') {
        response.writeHead(304)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', etag: 'W/"v1"' })
      response.end(JSON.stringify(payload))
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  assert.ok(X509Certificate)
  assert.ok(generateKeyPairSync)
})

after(() => {
  server?.close()
})

/**
 * Real `fetch` with TLS verification disabled for the self-signed certificate,
 * and no IP pinning so loopback is reachable. Everything else — method,
 * headers, redirect policy, response handling — is the production path.
 */
const loopbackFetch = (async (url: URL | string, init?: RequestInit) => {
  const undici = await import('undici')
  const agent = new undici.Agent({ connect: { rejectUnauthorized: false } })
  return undici.fetch(String(url), { ...(init as never), dispatcher: agent }) as unknown as Response
}) as never

test('fetches real JSON over TLS and normalizes it', async () => {
  mode = 'ok'
  const outcome = await fetchDashboardSource(
    { origin, path: '/v1/points' },
    policy,
    { fetchImpl: loopbackFetch },
  )
  assert.equal(outcome.status, 'ok')
  assert.ok(outcome.status === 'ok')

  const dataset = await normalizeDashboardDocument({
    document: outcome.document,
    transform: 'points',
    columns,
    fetchedAt: new Date('2026-08-13T12:00:00Z'),
  })
  assert.equal(dataset.rows.length, 2)
  assert.equal(dataset.rows[0]?.ok, 120)
  assert.equal(dataset.rows[1]?.note, 'second')
})

test('sends identity encoding and a JSON accept header over the wire', async () => {
  mode = 'ok'
  await fetchDashboardSource({ origin, path: '/v1/points' }, policy, { fetchImpl: loopbackFetch })
  assert.equal(lastHeaders['accept-encoding'], 'identity')
  assert.equal(lastHeaders.accept, 'application/json')
  assert.equal(lastHeaders.cookie, undefined)
})

test('carries a bearer credential to the server', async () => {
  mode = 'ok'
  await fetchDashboardSource(
    { origin, path: '/v1/points', credential: { mode: 'bearer', value: 'sk-live-xyz' } },
    policy,
    { fetchImpl: loopbackFetch },
  )
  assert.equal(lastHeaders.authorization, 'Bearer sk-live-xyz')
})

test('a real 304 short-circuits without a body', async () => {
  mode = 'etag'
  const outcome = await fetchDashboardSource(
    { origin, path: '/v1/points', etag: 'W/"v1"' },
    policy,
    { fetchImpl: loopbackFetch },
  )
  assert.equal(outcome.status, 'not_modified')
})

test('a 4 MiB streamed response is cut off at the cap', async () => {
  mode = 'huge'
  await assert.rejects(
    fetchDashboardSource({ origin, path: '/v1/points' }, policy, { fetchImpl: loopbackFetch }),
    (error: { code?: string }) => error.code === 'SOURCE_RESPONSE_TOO_LARGE',
  )
})

test('a real HTML response is refused', async () => {
  mode = 'html'
  await assert.rejects(
    fetchDashboardSource({ origin, path: '/v1/points' }, policy, { fetchImpl: loopbackFetch }),
    (error: { code?: string }) => error.code === 'SOURCE_NOT_JSON',
  )
})

test('the SSRF guard refuses loopback on the real safeFetch path', async () => {
  mode = 'ok'
  // No fetchImpl override: this goes through safeFetch's resolve-and-pin, which
  // must reject a loopback address regardless of what the URL looks like.
  await assert.rejects(
    fetchDashboardSource({ origin, path: '/v1/points' }, policy),
    (error: { code?: string }) => error.code === 'SOURCE_URL_REJECTED',
  )
})
