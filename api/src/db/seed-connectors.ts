import type { PrismaClient } from '@prisma/client'

/**
 * Seed the public App Store with real, reachable MCP connectors so the
 * store isn't empty on a fresh install and the install → invoke path can be
 * exercised end to end.
 *
 * Spec: `docs/plans/2026-05-30-mcp-store-publishing-approval.md`.
 *
 * Seeded entries are `public` + `published` and ownerless (they belong to the
 * store, not a user). `createdBy` is attributed to the first `owner`-role
 * member when one exists, falling back to a stable nil UUID so the seed works
 * before any account is bootstrapped. Idempotent: keyed on deterministic ids.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

type SeedConnector = {
  id: string
  name: string
  label: string
  description: string
  authMethod?: 'bearer' | 'none'
  vendor: string
  sourceUrl: string
  /** MCP endpoint, stored as the catalog default transport when known. */
  url?: string
  protocol: 'http' | 'sse'
}

/**
 * Context7 (Upstash) — a public, no-auth HTTP MCP server that serves
 * up-to-date library documentation. Chosen as the seed connector precisely
 * because it needs no credentials, so a freshly seeded store is immediately
 * installable and invokable.
 */
const SEED_CONNECTORS: SeedConnector[] = [
  {
    id: 'b0c7e6d2-7e2a-4f1a-9c3e-000000000001',
    name: 'context7',
    label: 'Context7',
    description:
      'Up-to-date code documentation and examples for libraries and frameworks, '
      + 'served over a public no-auth HTTP MCP endpoint.',
    vendor: 'Upstash',
    sourceUrl: 'https://github.com/upstash/context7',
    protocol: 'http',
    url: 'https://mcp.context7.com/mcp',
  },
  {
    id: 'b0c7e6d2-7e2a-4f1a-9c3e-000000000002',
    name: 'crawl4ai',
    label: 'Crawl4AI',
    description:
      'Self-hosted Crawl4AI web scanning and crawling over MCP. Install with '
      + 'a reachable SSE endpoint such as https://crawler.example.com/mcp/sse.',
    authMethod: 'bearer',
    vendor: 'Crawl4AI',
    sourceUrl: 'https://github.com/unclecode/crawl4ai',
    protocol: 'sse',
  },
]

const resolveSeedAuthor = async (prisma: PrismaClient): Promise<string> => {
  const owner = await prisma.organizationMember.findFirst({
    where: { role: 'owner' },
    orderBy: { id: 'asc' },
    select: { userId: true },
  })
  return owner?.userId ?? NIL_UUID
}

export const seedPublicConnectors = async (
  prisma: PrismaClient,
): Promise<{ seeded: number }> => {
  const createdBy = await resolveSeedAuthor(prisma)
  let seeded = 0

  for (const connector of SEED_CONNECTORS) {
    const transportConfig = connector.url
      ? { transport: connector.protocol, url: connector.url }
      : {}
    const authMethod = connector.authMethod ?? 'none'
    const authConfig = { method: authMethod }
    await prisma.mcpCatalogEntry.upsert({
      where: { id: connector.id },
      update: {
        label: connector.label,
        description: connector.description,
        vendor: connector.vendor,
        sourceUrl: connector.sourceUrl,
        protocol: connector.protocol,
        authMethod,
        authConfig,
        defaultTransportConfig: transportConfig,
        visibility: 'public',
        status: 'published',
      },
      create: {
        id: connector.id,
        organizationId: null,
        name: connector.name,
        label: connector.label,
        description: connector.description,
        protocol: connector.protocol,
        authMethod,
        authConfig,
        defaultTransportConfig: transportConfig,
        vendor: connector.vendor,
        sourceUrl: connector.sourceUrl,
        status: 'published',
        visibility: 'public',
        ownerUserId: null,
        createdBy,
      },
    })
    seeded += 1
  }

  return { seeded }
}
