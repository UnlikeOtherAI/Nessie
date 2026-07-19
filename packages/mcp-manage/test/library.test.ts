import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CURATED_MCP_LIBRARY,
  libraryEntryToCatalogInput,
  searchMcpLibrary,
  searchMcpRegistry,
  McpLibraryError,
} from '../src/index.js'

const registryPayload = (servers: unknown[]): Response =>
  new Response(JSON.stringify({ servers }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const remoteServer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  server: {
    name: 'io.example/notion-mcp',
    title: 'Notion',
    description: 'Notion workspace tools',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    ...overrides,
  },
})

test('searchMcpRegistry maps streamable-http remotes to http entries', async () => {
  const fetchImpl = (async () => registryPayload([remoteServer()])) as typeof fetch
  const entries = await searchMcpRegistry('notion', { fetchImpl })
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.source, 'registry')
  assert.equal(entries[0]?.transport, 'http')
  assert.equal(entries[0]?.url, 'https://mcp.example.com/mcp')
  assert.equal(entries[0]?.name, 'notion-mcp')
  assert.equal(entries[0]?.vendor, 'io.example')
  assert.equal(entries[0]?.authMethod, 'none')
})

test('searchMcpRegistry drops package-only (stdio) servers', async () => {
  const fetchImpl = (async () =>
    registryPayload([
      remoteServer({ remotes: undefined, packages: [{ registryType: 'npm' }] }),
    ])) as typeof fetch
  const entries = await searchMcpRegistry('x', { fetchImpl })
  assert.equal(entries.length, 0)
})

test('searchMcpRegistry classifies a required secret Authorization header as bearer', async () => {
  const fetchImpl = (async () =>
    registryPayload([
      remoteServer({
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.example.com/mcp',
            headers: [
              {
                name: 'Authorization',
                value: 'Bearer {api_key}',
                isRequired: true,
                isSecret: true,
              },
            ],
          },
        ],
      }),
    ])) as typeof fetch
  const entries = await searchMcpRegistry('x', { fetchImpl })
  assert.equal(entries[0]?.authMethod, 'bearer')
})

test('searchMcpRegistry classifies other required secret headers as api_key', async () => {
  const fetchImpl = (async () =>
    registryPayload([
      remoteServer({
        remotes: [
          {
            type: 'sse',
            url: 'https://mcp.example.com/sse',
            headers: [
              { name: 'X-Api-Key', isRequired: true, isSecret: true },
            ],
          },
        ],
      }),
    ])) as typeof fetch
  const entries = await searchMcpRegistry('x', { fetchImpl })
  assert.equal(entries[0]?.transport, 'sse')
  assert.equal(entries[0]?.authMethod, 'api_key')
})

test('searchMcpRegistry throws a typed error on non-200', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as typeof fetch
  await assert.rejects(
    searchMcpRegistry('x', { fetchImpl }),
    (error: unknown) => error instanceof McpLibraryError,
  )
})

test('searchMcpLibrary merges curated + registry and survives registry outages', async () => {
  const fetchImpl = (async () => {
    throw new Error('offline')
  }) as typeof fetch
  const { entries, registryError } = await searchMcpLibrary('github', { fetchImpl })
  assert.ok(entries.some((entry) => entry.key === 'github' && entry.source === 'curated'))
  assert.ok(registryError !== null)
})

test('searchMcpLibrary dedups registry entries that match curated endpoints', async () => {
  const curatedGithub = CURATED_MCP_LIBRARY.find((entry) => entry.key === 'github')
  assert.ok(curatedGithub)
  const fetchImpl = (async () =>
    registryPayload([
      remoteServer({
        name: 'com.github/github-mcp',
        remotes: [{ type: 'streamable-http', url: curatedGithub.url }],
      }),
    ])) as typeof fetch
  const { entries } = await searchMcpLibrary('github', { fetchImpl })
  const matching = entries.filter(
    (entry) => entry.url.replace(/\/$/, '') === curatedGithub.url.replace(/\/$/, ''),
  )
  assert.equal(matching.length, 1)
  assert.equal(matching[0]?.source, 'curated')
})

test('managed DeepSignal is integration-only and absent from generic install library', () => {
  const deepSignal = CURATED_MCP_LIBRARY.find((entry) => entry.key === 'deepsignal')
  assert.equal(deepSignal, undefined)
})

test('curated library only lists remote transports with expressible auth', () => {
  for (const entry of CURATED_MCP_LIBRARY) {
    assert.ok(['http', 'sse'].includes(entry.transport), entry.key)
    assert.ok(['none', 'bearer', 'api_key', 'oauth2'].includes(entry.authMethod), entry.key)
    assert.ok(entry.url.startsWith('https://'), entry.key)
  }
})

test('libraryEntryToCatalogInput builds a valid discriminated auth config', () => {
  const bearer = libraryEntryToCatalogInput({
    source: 'curated',
    key: 'x',
    name: 'x',
    label: 'X',
    description: '',
    vendor: null,
    sourceUrl: null,
    url: 'https://mcp.example.com/mcp',
    transport: 'http',
    authMethod: 'bearer',
    authHint: null,
  })
  assert.deepEqual(bearer.authConfig, { method: 'bearer' })
  assert.deepEqual(bearer.defaultTransportConfig, {
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
  })

  const apiKey = libraryEntryToCatalogInput({
    source: 'registry',
    key: 'y',
    name: 'y',
    label: 'Y',
    description: '',
    vendor: null,
    sourceUrl: null,
    url: 'https://mcp.example.com/sse',
    transport: 'sse',
    authMethod: 'api_key',
    authHint: null,
  })
  assert.deepEqual(apiKey.authConfig, {
    method: 'api_key',
    headerName: 'Authorization',
    valuePrefix: '',
  })
})
