import type {
  McpAppCategory,
  McpAppTrustLevel,
  PrismaClient,
} from '@prisma/client'

/**
 * Give every connector that already exists a real App Store presence.
 *
 * The store is a second face on `mcp_catalog_entries`, not a second catalogue
 * (`api/prisma/migrations/20260829090000_mcp_app_store_catalogue`), so this
 * seed **enriches** rows other code already created — the two public
 * connectors from `seed-connectors.ts` and the three first-party products from
 * their own migrations. It never inserts a catalogue row: transport, protocol,
 * and auth belong to whoever owns the connector, and a second definition here
 * would be a fork of them. A listing whose row is absent is reported, not
 * invented. `buildme` is deliberately missing from this list — its manifest
 * carries `catalogTemplate: null` because it is link-only until BuildMe
 * publishes a board API, so it has no catalogue row to enrich.
 *
 * Copy rule (`docs/plans/2026-08-29-mcp-app-store/ux-design-detail-and-connect.md`):
 * descriptions say what a person's agents can now do. No endpoints, no
 * transports, no auth vocabulary — the card and the hero are both product
 * surfaces, not connector inspectors.
 */

type AppListing = {
  /** Fixed catalogue id from the migration or seed that created the row. */
  id: string
  /** Catalogue `name` — the fallback key; see `resolveCatalogEntry`. */
  name: string
  /**
   * `integrated_products.slug` for the three first-party products, which own
   * their catalogue row through that link. Absent for the two ordinary public
   * connectors `seed-connectors.ts` writes, which have no product row.
   */
  productSlug?: string
  slug: string
  displayName: string
  shortDescription: string
  longDescription: string
  websiteUrl?: string
  repositoryUrl?: string
  primaryCategory: McpAppCategory
  /** Extra memberships beyond the primary, which is added back on write. */
  secondaryCategories: McpAppCategory[]
  tags: string[]
  /** Curated synonyms: the words someone actually types when they want this. */
  aliases: string[]
  trustLevel: McpAppTrustLevel
  /**
   * Present iff the app belongs on the Featured shelf. Order and membership
   * are one field so they cannot disagree — a featured app with no order
   * sorts arbitrarily, which is worse than not being featured. The sequence
   * mirrors `integrated_products.sort_order` (10 / 15 / 20) rather than
   * inventing a second opinion about which product leads.
   */
  featuredOrder?: number
}

const APP_LISTINGS: AppListing[] = [
  {
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d111',
    name: 'deep-water',
    productSlug: 'deep-water',
    slug: 'deep-water',
    // 'Deep Water' is the name the Integrations page, the product row, and the
    // plugin manifest all use; the store must not be the one surface that
    // renames it.
    displayName: 'Deep Water',
    shortDescription:
      'Ask a research question and get a written, cited report back — the searching, '
      + 'reading, and cross-checking happens for you.',
    longDescription:
      'Deep Water takes a question that would cost you an afternoon of tabs — a market, '
      + 'a vendor, a technical trade-off, a regulation that just changed — and works it '
      + 'properly: it searches, reads what it finds, follows the threads that matter, and '
      + 'comes back with a written report and the sources behind every claim.\n\n'
      + 'Your agents can launch a run from inside a conversation and file the finished '
      + 'report into Knowledge, so the research ends up beside the work it was for instead '
      + 'of in somebody\'s notes. Long runs continue in the background and report back when '
      + 'they land.',
    primaryCategory: 'ai_search',
    secondaryCategories: ['productivity'],
    tags: ['research', 'reports', 'sources', 'citations', 'analysis'],
    aliases: [
      'research',
      'deep research',
      'deepwater',
      'literature review',
      'market research',
      'due diligence',
      'report',
    ],
    trustLevel: 'nessie',
    featuredOrder: 1,
  },
  {
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d114',
    name: 'deepsignal',
    productSlug: 'deepsignal',
    slug: 'deepsignal',
    displayName: 'DeepSignal',
    shortDescription:
      'Keeps watch on the things you decided matter and tells you when something changes, '
      + 'before you would have noticed yourself.',
    longDescription:
      'DeepSignal holds a standing watch over the subjects you name — a market, a '
      + 'competitor, an account, a piece of regulation — and surfaces only what changed and '
      + 'why it matters to the objective you set for it.\n\n'
      + 'Rather than another feed to read, you get a short digest of the signals worth a '
      + 'decision. Mark one done, snooze it, or ask for the reasoning in your own words; it '
      + 'answers in its own conversation, so following a signal into a question and back out '
      + 'again stays one thread instead of three tools.',
    websiteUrl: 'https://deepsignal.live',
    primaryCategory: 'ai_search',
    secondaryCategories: ['analytics'],
    tags: ['monitoring', 'alerts', 'signals', 'insights', 'decisions'],
    aliases: [
      'signals',
      'monitoring',
      'alerts',
      'watch',
      'insights',
      'deepsignal',
      'market intelligence',
      'competitor tracking',
    ],
    trustLevel: 'nessie',
    featuredOrder: 2,
  },
  {
    id: '8f3a5a00-0e64-4d10-a517-0d0b69c1d112',
    name: 'deeptest',
    productSlug: 'deeptest',
    slug: 'deeptest',
    displayName: 'DeepTest',
    shortDescription:
      'Puts a codebase through a security review and hands back findings, without the '
      + 'source ever leaving your side.',
    longDescription:
      'DeepTest reviews code the way a security engineer would — hunting the weaknesses '
      + 'that actually get exploited rather than listing every lint warning — and returns a '
      + 'report you can hand straight to whoever has to fix it.\n\n'
      + 'The review runs against your own checkout on a runner you control, so source, '
      + 'diffs, and raw findings stay yours and only the share-safe report comes back. Ask '
      + 'an agent for a review before a release and read the summary in the channel where '
      + 'the release is being planned.',
    websiteUrl: 'https://deeptest.live',
    primaryCategory: 'development',
    secondaryCategories: ['infrastructure'],
    tags: ['security', 'code review', 'vulnerabilities', 'testing'],
    aliases: [
      'security',
      'pentest',
      'scan',
      'penetration testing',
      'vulnerability scan',
      'security review',
      'deeptest',
      'appsec',
    ],
    trustLevel: 'nessie',
    featuredOrder: 3,
  },
  {
    id: 'b0c7e6d2-7e2a-4f1a-9c3e-000000000001',
    name: 'context7',
    slug: 'context7',
    displayName: 'Context7',
    shortDescription:
      'Gives your agents the current documentation for the libraries you actually use, so '
      + 'the code they write matches the version you have installed.',
    longDescription:
      'Context7 answers the question every coding agent gets wrong from memory: what does '
      + 'this library look like today. It pulls current documentation and working examples '
      + 'for a named package, which is the difference between an agent writing the API that '
      + 'existed two years ago and the one in your lockfile.\n\n'
      + 'It asks for no account and no keys, so it is the fastest thing here to turn on.',
    repositoryUrl: 'https://github.com/upstash/context7',
    primaryCategory: 'development',
    secondaryCategories: ['ai_search'],
    tags: ['documentation', 'libraries', 'frameworks', 'code examples', 'api reference'],
    aliases: [
      'docs',
      'documentation',
      'library docs',
      'api docs',
      'code examples',
      'reference',
      'context7',
      'upstash',
    ],
    trustLevel: 'verified',
  },
  {
    id: 'b0c7e6d2-7e2a-4f1a-9c3e-000000000002',
    name: 'deep-agent-crawl',
    slug: 'deep-agent-crawl',
    displayName: 'deep.agent Crawl',
    shortDescription:
      'Lets your agents read whole pages and sites for themselves, instead of working from '
      + 'a search snippet.',
    longDescription:
      'deep.agent Crawl fetches and extracts real page content — a documentation site, a '
      + 'competitor\'s pricing page, a long article behind a click — and hands the text to '
      + 'an agent in a form it can reason over. Reach for it when a search result is not '
      + 'enough and the answer is three levels into a site.\n\n'
      + 'It runs on your own deep.agent deployment, so which sites get visited and what gets '
      + 'kept is your call rather than a vendor\'s.',
    websiteUrl: 'https://deep.agent',
    primaryCategory: 'ai_search',
    secondaryCategories: ['data_databases'],
    tags: ['web scraping', 'crawling', 'content extraction', 'scanning'],
    aliases: [
      'crawl',
      'crawler',
      'scrape',
      'scraping',
      'web scraping',
      'spider',
      'fetch pages',
      'deep agent',
    ],
    trustLevel: 'verified',
  },
]

type CatalogEntryRef = { id: string; slug: string | null }

/**
 * The first-party migrations key their upsert on `(name, visibility='public')`
 * and only insert the fixed id when no public row of that name exists yet. On
 * an instance that had already published a connector under one of these names
 * the canonical row therefore carries a different id, and resolving by id
 * alone would miss it — and a Prisma `upsert` would then add a second row for
 * the same app. Falling back to the name is what keeps this seed to exactly
 * one row per app.
 *
 * The fallback is scoped to the rows those products actually own, because
 * `name` alone is not identity: `mcp_catalog_entries` is unique on name only
 * among *public* entries, and an organisation is free to publish its own
 * connector called `deep-water`. Stamping `trustLevel: 'nessie'`,
 * `moderationState: 'approved'`, Featured, and first-party marketing copy onto
 * that row would forge exactly the trust signal the badge exists to carry.
 * Two conditions close it: `organizationId: null` (an instance-global row,
 * which no tenant-scoped create can produce) and, for a first-party product,
 * the `IntegratedProduct` link that makes the row its own. A same-name row
 * that satisfies neither is reported missing, which is the truth — the
 * first-party listing has no row here to enrich.
 */
const resolveCatalogEntry = async (
  prisma: PrismaClient,
  listing: AppListing,
): Promise<CatalogEntryRef | null> => {
  const byId = await prisma.mcpCatalogEntry.findUnique({
    where: { id: listing.id },
    select: { id: true, slug: true },
  })
  if (byId) {
    return byId
  }

  return prisma.mcpCatalogEntry.findFirst({
    where: {
      name: listing.name,
      visibility: 'public',
      organizationId: null,
      ...(listing.productSlug
        ? { integratedProducts: { some: { slug: listing.productSlug } } }
        : {}),
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, slug: true },
  })
}

export const seedAppStoreListings = async (
  prisma: PrismaClient,
): Promise<{ enriched: number; missing: string[] }> => {
  let enriched = 0
  const missing: string[] = []

  for (const listing of APP_LISTINGS) {
    const entry = await resolveCatalogEntry(prisma, listing)
    if (!entry) {
      missing.push(listing.name)
      continue
    }

    await prisma.mcpCatalogEntry.update({
      where: { id: entry.id },
      data: {
        // `slug` is the immutable public identity behind `/apps/:slug`: a link
        // already in somebody's hands has to keep resolving, so the seed fills
        // it only where the row has none. The store migration backfilled it
        // from `name` for everything that predates it; rows created afterwards
        // by `seed-connectors.ts` are what this actually names.
        ...(entry.slug === null ? { slug: listing.slug } : {}),
        displayName: listing.displayName,
        shortDescription: listing.shortDescription,
        longDescription: listing.longDescription,
        websiteUrl: listing.websiteUrl ?? null,
        documentationUrl: null,
        repositoryUrl: listing.repositoryUrl ?? null,
        primaryCategory: listing.primaryCategory,
        // The primary is repeated in `categories` so membership is one
        // question with one answer: `categories` contains every category this
        // app belongs to, and `primaryCategory` only says which of them owns
        // its place in the default scroll.
        categories: [listing.primaryCategory, ...listing.secondaryCategories],
        tags: listing.tags,
        aliases: listing.aliases,
        trustLevel: listing.trustLevel,
        moderationState: 'approved',
        appSource: 'nessie',
        // Every connector that exists today is an HTTP/SSE endpoint Nessie
        // reaches over the network. `package` and `builtin` have no rows yet.
        distribution: 'remote',
        featured: listing.featuredOrder !== undefined,
        featuredOrder: listing.featuredOrder ?? null,
      },
    })
    enriched += 1
  }

  return { enriched, missing }
}
