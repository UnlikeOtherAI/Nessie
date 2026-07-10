import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpClientManager } from '@nessie/mcp-client'

import { candidateUrlsFor, discoverMcpEndpoint } from '../src/index.js'

// A public, non-reserved IP literal: passes the SSRF guard without DNS.
const BASE = 'https://93.184.216.34'

test('candidateUrlsFor appends well-known suffixes once', () => {
  assert.deepEqual(candidateUrlsFor(`${BASE}`), [
    `${BASE}`,
    `${BASE}/mcp`,
    `${BASE}/sse`,
    `${BASE}/mcp/sse`,
  ])
  // Already ends in /mcp — that suffix is not doubled up.
  const forMcp = candidateUrlsFor(`${BASE}/mcp`)
  assert.ok(forMcp.includes(`${BASE}/mcp`))
  assert.ok(!forMcp.includes(`${BASE}/mcp/mcp`))
})

test('candidateUrlsFor normalises a bare domain to https', () => {
  const urls = candidateUrlsFor('93.184.216.34')
  assert.equal(urls[0], 'https://93.184.216.34')
})

const fakeManager = (
  behaviour: (spec: { url?: string }) => { tools?: Array<{ name: string }>; error?: string },
): McpClientManager => {
  return {
    open: async (spec: { url?: string }) => {
      const result = behaviour(spec)
      if (result.error) throw new Error(result.error)
      return `conn-${spec.url}` as never
    },
    listTools: async (id: string) => {
      const url = id.replace('conn-', '')
      const result = behaviour({ url })
      return (result.tools ?? []) as never
    },
    close: async () => undefined,
    closeAll: async () => undefined,
  } as unknown as McpClientManager
}

test('discoverMcpEndpoint returns a no-auth proposal when a candidate answers tools/list', async () => {
  const result = await discoverMcpEndpoint(`${BASE}`, {
    managerFactory: () =>
      fakeManager((spec) =>
        spec.url === `${BASE}/mcp`
          ? { tools: [{ name: 'search' }, { name: 'fetch' }] }
          : { error: 'connect ECONNREFUSED' },
      ),
    fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    probeTimeoutMs: 2_000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.proposal?.url, `${BASE}/mcp`)
  assert.equal(result.proposal?.transport, 'http')
  assert.equal(result.proposal?.authMethod, 'none')
  assert.deepEqual(result.proposal?.toolNames, ['search', 'fetch'])
})

test('discoverMcpEndpoint proposes bearer auth when the endpoint rejects with 401', async () => {
  const result = await discoverMcpEndpoint(`${BASE}/mcp`, {
    managerFactory: () =>
      fakeManager(() => ({ error: 'Error POSTing to endpoint (HTTP 401)' })),
    fetchImpl: (async () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' },
      })) as typeof fetch,
    probeTimeoutMs: 2_000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.proposal?.authMethod, 'bearer')
  assert.match(result.proposal?.note ?? '', /OAuth/)
})

test('discoverMcpEndpoint blocks private addresses via the SSRF guard', async () => {
  const result = await discoverMcpEndpoint('https://192.168.1.10/mcp', {
    managerFactory: () => fakeManager(() => ({ tools: [] })),
    fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch,
    probeTimeoutMs: 2_000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.proposal, null)
  assert.ok(result.attempts.every((attempt) => attempt.outcome === 'blocked'))
})

test('discoverMcpEndpoint reports not found when nothing speaks MCP', async () => {
  const result = await discoverMcpEndpoint(`${BASE}`, {
    managerFactory: () => fakeManager(() => ({ error: 'connect ECONNREFUSED' })),
    fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    probeTimeoutMs: 2_000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.proposal, null)
})
