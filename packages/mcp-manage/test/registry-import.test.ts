import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { syncRegistry } from '../src/index.js'

/**
 * The importer, against an in-memory stand-in for the four Prisma calls it
 * makes. What is being tested is the *policy* — one bad record never fails the
 * import, a re-sync never churns a curated value, an unsafe endpoint is never
 * persisted — none of which needs a database to be true.
 */

type Row = Record<string, unknown>

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && 'not' in expected) {
      return row[key] !== (expected as { not: unknown }).not
    }
    return row[key] === expected
  })

const createFakePrisma = (): {
  prisma: PrismaClient
  entries: Row[]
  runs: Row[]
} => {
  const entries: Row[] = []
  const runs: Row[] = []
  const prisma = {
    mcpCatalogEntry: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `app-${entries.length + 1}`, ...data }
        entries.push(row)
        return row
      },
      findFirst: async ({ where }: { where: Row }) =>
        entries.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        entries.filter((row) => matches(row, where)),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = entries.find((entry) => entry.id === where.id)
        assert.ok(row, 'update targeted a row that exists')
        Object.assign(row, data)
        return row
      },
    },
    mcpRegistrySyncRun: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `run-${runs.length + 1}`, ...data }
        runs.push(row)
        return row
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = runs.find((entry) => entry.id === where.id)
        assert.ok(row, 'run update targeted a row that exists')
        Object.assign(row, data)
        return row
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, entries, runs }
}

const record = (
  server: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): unknown => ({
  server: {
    name: 'io.github.acme/notion-mcp',
    description: 'Search, read and update pages in your Notion workspace.',
    version: '1.0.0',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
    ...server,
  },
  _meta: {
    'io.modelcontextprotocol.registry/official': {
      status: 'active',
      isLatest: true,
      updatedAt: '2026-03-04T12:30:00Z',
      ...meta,
    },
  },
})

/** One page, then done — the cursor is absent, which is the last page. */
const pageOf = (servers: unknown[]): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ servers, metadata: { count: servers.length } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

/** As `seed-connectors.ts` writes it: instance-global, public, no registry name. */
const seededRow = (url: string, overrides: Row = {}): Row => ({
  id: 'seed-context7',
  organizationId: null,
  name: 'context7',
  label: 'Context7',
  description: 'Up-to-date code documentation and examples for libraries.',
  vendor: 'Upstash',
  sourceUrl: 'https://github.com/upstash/context7',
  displayName: null,
  shortDescription: null,
  websiteUrl: null,
  documentationUrl: null,
  repositoryUrl: null,
  primaryCategory: 'other',
  categories: [],
  tags: [],
  aliases: [],
  trustLevel: 'unknown',
  defaultTransportConfig: { transport: 'http', url },
  moderationState: 'curated',
  appSource: 'nessie',
  visibility: 'public',
  status: 'published',
  registryName: null,
  upstream: {},
  ...overrides,
})

const allowAll = async (): Promise<void> => undefined

test('imports a registry record as a published, instance-global catalogue row', async () => {
  const { prisma, entries, runs } = createFakePrisma()

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([record({})]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversFetched, 1)
  assert.equal(result.serversCreated, 1)
  assert.equal(result.serversFailed, 0)
  assert.equal(entries.length, 1)

  const row = entries[0]!
  assert.equal(row.registryName, 'io.github.acme/notion-mcp')
  assert.equal(row.appSource, 'mcp_registry')
  assert.equal(row.distribution, 'remote')
  assert.equal(row.organizationId, null)
  assert.equal(row.ownerUserId, null)
  assert.equal(row.visibility, 'public')
  assert.equal(row.status, 'published')
  assert.equal(row.createdBy, '00000000-0000-0000-0000-000000000000')
  assert.equal(row.name, 'notion-mcp')
  assert.equal(row.slug, 'notion')
  assert.equal(row.displayName, 'Notion')
  assert.equal(row.trustLevel, 'community')
  assert.equal(row.primaryCategory, 'productivity')
  assert.deepEqual(row.defaultTransportConfig, {
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
  })

  // The run is closed and says what happened.
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.serversCreated, 1)
  assert.ok(runs[0]!.completedAt instanceof Date)
  assert.equal(runs[0]!.error, null)
})

test('falls back to the matching repository descriptor when the registry publishes no icon', async () => {
  const { prisma, entries } = createFakePrisma()
  const repositoryCalls: Array<{ endpointUrl: string; repositoryUrl: string | null }> = []

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([record({ repository: { url: 'https://github.com/figma/mcp-server-guide' } })]),
    assertEndpointSafe: allowAll,
    repositoryIconCacher: async (input) => {
      repositoryCalls.push(input)
      return { attachmentId: 'figma-icon', source: 'mcp_repository' }
    },
  })

  assert.equal(result.iconsCached, 1)
  assert.deepEqual(repositoryCalls, [{
    displayName: 'Notion',
    endpointUrl: 'https://mcp.example.com/mcp',
    repositoryUrl: 'https://github.com/figma/mcp-server-guide',
  }])
  assert.equal(entries[0]?.iconAttachmentId, 'figma-icon')
  assert.equal(entries[0]?.iconSource, 'mcp_repository')
})

test('one malformed record is counted and described, never thrown', async () => {
  const { prisma, entries, runs } = createFakePrisma()

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([
      { server: { title: 'no name at all' } },
      record({}),
      'not even an object',
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversFetched, 3)
  assert.equal(result.serversFailed, 2)
  assert.equal(result.serversCreated, 1, 'the good record still imported')
  assert.equal(entries.length, 1)

  const failures = runs[0]!.failures as Array<{ reason: string }>
  assert.equal(failures.length, 2)
  assert.ok(failures[0]!.reason.startsWith('unreadable registry record:'))
})

test('records that do not apply are skipped, not failed', async () => {
  const { prisma, entries } = createFakePrisma()

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({ remotes: undefined }),
      record({ name: 'io.example/old' }, { isLatest: false }),
      record({ name: 'io.example/gone' }, { status: 'deleted' }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversSkipped, 3)
  assert.equal(result.serversFailed, 0)
  assert.equal(entries.length, 0)
})

test('an endpoint the SSRF guard refuses is never persisted at all', async () => {
  const { prisma, entries } = createFakePrisma()

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({
        name: 'io.example/internal',
        remotes: [{ type: 'streamable-http', url: 'https://internal.corp/mcp' }],
      }),
      record({}),
    ]),
    assertEndpointSafe: async (url: string) => {
      if (url.includes('internal')) throw new Error('address is not routable')
    },
  })

  assert.equal(result.serversSkipped, 1)
  assert.equal(result.serversCreated, 1)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.registryName, 'io.github.acme/notion-mcp')
})

test('promotion is objective: it clears the gates or it stays discovered', async () => {
  const { prisma, entries } = createFakePrisma()

  await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({}),
      record({ name: 'io.example/thin', description: 'A server.' }),
      record({
        name: 'io.example/insecure',
        remotes: [{ type: 'streamable-http', url: 'http://mcp.example.com/mcp' }],
      }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(entries.length, 3)
  assert.equal(entries[0]!.moderationState, 'curated')
  assert.equal(entries[1]!.moderationState, 'discovered', 'description too thin')
  assert.equal(entries[2]!.moderationState, 'discovered', 'endpoint is not https')
  // Never `approved`: that state means a human decided.
  assert.equal(entries.some((row) => row.moderationState === 'approved'), false)
})

test('a moderator’s removal outranks a later sync', async () => {
  const { prisma, entries } = createFakePrisma()
  const options = { fetchImpl: pageOf([record({})]), assertEndpointSafe: allowAll }

  await syncRegistry(prisma, options)
  entries[0]!.moderationState = 'hidden'
  await syncRegistry(prisma, options)

  assert.equal(entries[0]!.moderationState, 'hidden')
})

test('running the sync twice creates no second row and moves no curated value', async () => {
  const { prisma, entries } = createFakePrisma()
  const options = { fetchImpl: pageOf([record({})]), assertEndpointSafe: allowAll }

  const first = await syncRegistry(prisma, options)
  const snapshot = { ...entries[0] }
  const second = await syncRegistry(prisma, options)

  assert.equal(first.serversCreated, 1)
  assert.equal(second.serversCreated, 0)
  assert.equal(second.serversUpdated, 1)
  assert.equal(entries.length, 1)
  for (const key of ['slug', 'name', 'displayName', 'primaryCategory', 'tags', 'aliases']) {
    assert.deepEqual(entries[0]![key], snapshot[key], key)
  }
})

test('what a curator wrote survives a re-sync; what only sync wrote is refreshed', async () => {
  const { prisma, entries } = createFakePrisma()
  const upstream = 'Search, read and update pages in your Notion workspace.'

  await syncRegistry(prisma, {
    fetchImpl: pageOf([record({})]),
    assertEndpointSafe: allowAll,
  })
  assert.equal(entries[0]!.shortDescription, upstream)

  // A human renames the app and picks a different shelf for it.
  entries[0]!.displayName = 'Notion (workspace)'
  entries[0]!.primaryCategory = 'files_documents'

  await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({ description: 'Now with databases, comments and page history support.' }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(entries[0]!.displayName, 'Notion (workspace)', 'curated name kept')
  assert.equal(entries[0]!.primaryCategory, 'files_documents', 'curated shelf kept')
  assert.equal(
    entries[0]!.shortDescription,
    'Now with databases, comments and page history support.',
    'sync still owns the copy nobody touched',
  )
})

test('a colliding catalogue name falls back to the publisher namespace', async () => {
  const { prisma, entries } = createFakePrisma()

  await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({}),
      record({ name: 'io.github.other/notion-mcp' }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.name, 'notion-mcp')
  assert.equal(entries[1]!.name, 'io-github-other-notion-mcp')
  // Slug is the public identity and must stay unique too.
  assert.notEqual(entries[0]!.slug, entries[1]!.slug)
})

// ─── One server is one app (adoption) ────────────────────────────────────────

test('a seeded row for the same server is adopted, not duplicated beside it', async () => {
  const { prisma, entries } = createFakePrisma()
  entries.push(seededRow('https://mcp.context7.com/mcp'))

  const result = await syncRegistry(prisma, {
    // The same endpoint, spelled the way a publisher happens to spell it.
    fetchImpl: pageOf([record({
      name: 'io.github.upstash/context7',
      description: 'Up-to-date code documentation and examples, straight from the source.',
      remotes: [{ type: 'streamable-http', url: 'https://MCP.Context7.com/mcp/' }],
    })]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversCreated, 0, 'no rival row')
  assert.equal(result.serversUpdated, 1)
  assert.equal(entries.length, 1)

  const row = entries[0]!
  assert.equal(row.id, 'seed-context7')
  assert.equal(row.name, 'context7', 'no context7-2')
  assert.equal(row.registryName, 'io.github.upstash/context7', 'provenance stamped')
  assert.equal(row.appSource, 'mcp_registry')
  assert.equal(row.registryVersion, '1.0.0')
  assert.equal((row.upstream as Row).name, 'io.github.upstash/context7')
  // Curated copy is untouched; the columns nobody had filled are filled.
  assert.equal(row.label, 'Context7')
  assert.equal(row.description, 'Up-to-date code documentation and examples for libraries.')
  assert.deepEqual(row.defaultTransportConfig, {
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
  })
  assert.equal(
    row.shortDescription,
    'Up-to-date code documentation and examples, straight from the source.',
  )
})

test('an adopted row is claimed once; a second record with that endpoint gets its own', async () => {
  const { prisma, entries } = createFakePrisma()
  entries.push(seededRow('https://mcp.context7.com/mcp'))

  await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({
        name: 'io.github.upstash/context7',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.context7.com/mcp' }],
      }),
      record({
        name: 'io.github.someone-else/context7-mirror',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.context7.com/mcp' }],
      }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.registryName, 'io.github.upstash/context7')
  assert.equal(entries[1]!.registryName, 'io.github.someone-else/context7-mirror')
})

test('an organisation’s own entry is never adopted into a public registry app', async () => {
  const { prisma, entries } = createFakePrisma()
  // Public within one org (a shared library import), which is a different
  // shelf: adopting it would hand a public app to a single tenant.
  entries.push(seededRow('https://mcp.context7.com/mcp', {
    id: 'org-context7',
    organizationId: 'org-1',
  }))

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([record({
      name: 'io.github.upstash/context7',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.context7.com/mcp' }],
    })]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversCreated, 1)
  assert.equal(entries.length, 2)
  assert.equal(entries[0]!.id, 'org-context7')
  assert.equal(entries[0]!.registryName, null, 'the org’s row is left alone')
})

// ─── What gets persisted ─────────────────────────────────────────────────────

test('the endpoint is persisted canonically, so an admin lock still matches it', async () => {
  const { prisma, entries } = createFakePrisma()

  await syncRegistry(prisma, {
    fetchImpl: pageOf([record({
      remotes: [{ type: 'streamable-http', url: 'https://API.GitHubCopilot.com:443/mcp/' }],
    })]),
    assertEndpointSafe: allowAll,
  })

  assert.deepEqual(entries[0]!.defaultTransportConfig, {
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp',
  })
})

test('no ingested row is ever verified, however official it claims to be', async () => {
  const { prisma, entries } = createFakePrisma()

  await syncRegistry(prisma, {
    fetchImpl: pageOf([
      record({}),
      record({
        name: 'io.github.attacker/notion-official',
        title: 'Notion (Official)',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.notion.com/mcp' }],
      }),
    ]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(entries.length, 2)
  for (const row of entries) assert.equal(row.trustLevel, 'community')
})

// ─── Progress ────────────────────────────────────────────────────────────────

test('every page reports where the sweep has got to, empty pages included', async () => {
  const { prisma } = createFakePrisma()
  const pages = [
    { servers: [record({})], metadata: { nextCursor: 'p2' } },
    { servers: [], metadata: { nextCursor: 'p3' } },
    { servers: [record({ name: 'io.example/second' })], metadata: {} },
  ]
  let call = 0
  const fetchImpl = (async () =>
    new Response(JSON.stringify(pages[call++]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  const seen: Array<Record<string, unknown>> = []
  const result = await syncRegistry(prisma, {
    fetchImpl,
    assertEndpointSafe: allowAll,
    onProgress: (progress) => seen.push({ ...progress }),
  })

  assert.deepEqual(seen.map((p) => p.page), [1, 2, 3])
  assert.deepEqual(seen.map((p) => p.serversCreated), [1, 1, 2])
  assert.deepEqual(seen.map((p) => p.serversFetched), [1, 1, 2])
  // The run is named on the first page, which is all the API route waits for.
  for (const progress of seen) assert.equal(progress.runId, result.runId)
  assert.equal(seen.at(-1)!.serversSkipped, 0)
  assert.equal(seen.at(-1)!.serversFailed, 0)
})

test('a page over the byte cap fails the run, not one record', async () => {
  const { prisma, entries, runs } = createFakePrisma()
  const huge = 'x'.repeat(9 * 1024 * 1024)

  const result = await syncRegistry(prisma, {
    fetchImpl: pageOf([record({ description: huge })]),
    assertEndpointSafe: allowAll,
  })

  assert.equal(result.serversFetched, 0, 'nothing was read out of the page')
  assert.equal(result.serversFailed, 0, 'this is not a bad record')
  assert.equal(entries.length, 0)
  assert.match(result.error ?? '', /bytes/)
  assert.match(String(runs[0]!.error), /bytes/)
  assert.ok(runs[0]!.completedAt instanceof Date, 'the run is still closed')
})

test('a registry that dies mid-run keeps what it already imported and says why', async () => {
  const { prisma, entries, runs } = createFakePrisma()
  let call = 0
  const fetchImpl = (async () => {
    call += 1
    if (call === 1) {
      return new Response(
        JSON.stringify({ servers: [record({})], metadata: { nextCursor: 'page-2' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('nope', { status: 503 })
  }) as typeof fetch

  const result = await syncRegistry(prisma, { fetchImpl, assertEndpointSafe: allowAll })

  assert.equal(result.serversCreated, 1)
  assert.equal(entries.length, 1)
  assert.match(result.error ?? '', /HTTP 503/)
  assert.match(String(runs[0]!.error), /HTTP 503/)
  assert.ok(runs[0]!.completedAt instanceof Date, 'the run is still closed')
})
