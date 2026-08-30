import { parseArgs } from 'node:util'

import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'
import {
  classifyRegistryApp,
  readUpstreamSnapshot,
  type AppClassification,
} from '@nessie/mcp-manage'
import type { McpAppCategory, PrismaClient } from '@prisma/client'

/**
 * Re-run the deterministic categoriser over apps that are already ingested.
 *
 *   pnpm --filter @nessie/api recategorize:apps
 *   pnpm --filter @nessie/api recategorize:apps --dry-run
 *
 * The ~5,500 registry apps were classified at ingestion time. When the rule
 * table in `registry-categories.ts` grows, that expansion does nothing for the
 * apps already in the store — a re-sync only diffs against upstream, and an
 * unchanged upstream record produces an unchanged row. This is the backfill that
 * makes an expanded table visible: for every `mcp_registry` row it re-derives
 * the classification from the same `upstream` snapshot the importer read, and
 * re-shelves the rows the last sync left in the `other` catch-all.
 *
 * What it will NOT touch is a row a person has curated onto a real shelf. See
 * `isReshelvable` — the gate is the catalogue's own "undecided" sentinel, not a
 * guess.
 *
 * Idempotent by construction: a row it moves off `other` is no longer `other`,
 * so a second run skips it; a row nothing matches stays `other` and its
 * re-derived fields are byte-identical, so no write is even staged.
 */

/** One page of the id-ordered walk. Rows are small; the JSON `upstream` is not. */
const PAGE_SIZE = 500

/** Prisma batches this many updates per transaction — enough to be fast, bounded
 *  enough not to hold one giant transaction open over thousands of rows. */
const UPDATE_CHUNK = 200

type CatalogRow = {
  id: string
  name: string
  registryName: string | null
  description: string
  displayName: string | null
  primaryCategory: McpAppCategory
  categories: McpAppCategory[]
  tags: string[]
  aliases: string[]
  upstream: unknown
}

const ROW_SELECT = {
  id: true,
  name: true,
  registryName: true,
  description: true,
  displayName: true,
  primaryCategory: true,
  categories: true,
  tags: true,
  aliases: true,
  upstream: true,
} as const

type ReclassifyUpdate = {
  id: string
  primaryCategory: McpAppCategory
  categories: McpAppCategory[]
  tags: string[]
  aliases: string[]
}

/**
 * The exact `(name, title, description)` the importer fed the categoriser
 * (`mapRegistryRecord` → `classifyRegistryApp`), reconstructed from the stored
 * `upstream` snapshot. A snapshot that will not read back — an `{}` default, or
 * a row older than a schema field — falls back to the row's own columns, which
 * carry the same three facts.
 */
const classifierInput = (
  row: CatalogRow,
): { name: string; title: string | null; description: string } => {
  const snapshot = readUpstreamSnapshot(row.upstream)
  if (snapshot) {
    return { name: snapshot.name, title: snapshot.title, description: snapshot.description.trim() }
  }
  return {
    name: row.registryName ?? row.name,
    title: row.displayName,
    description: row.description.trim(),
  }
}

/**
 * A row whose `primaryCategory` is still `other` is the catalogue's own "nobody
 * has decided this yet" sentinel — precisely what `registry-merge`'s `isUnset`
 * treats as sync-owned for this column, and what this backfill is entitled to
 * re-shelve. A row already on a real shelf is left alone: once the rules have
 * changed we can no longer tell a curator's move from an older rule's answer,
 * and `mergeRegistryUpdate` errs toward the curator for exactly that reason.
 *
 * Deciding at the row level rather than through `mergeRegistryUpdate`'s
 * per-column merge is deliberate. Under a rules change the merge's
 * human-detection collapses to `isUnset` alone, and `isUnset` counts a populated
 * `categories` array (`['other']`) and a name-derived `aliases` array as *set* —
 * so it would move `primaryCategory` to `finance` while leaving
 * `categories: ['other']` behind, a half-classified row. Re-deriving the four
 * fields as one bundle keeps them consistent.
 */
const isReshelvable = (primaryCategory: McpAppCategory): boolean => primaryCategory === 'other'

const sameArray = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index])

/** The re-derived classification says something the stored row does not. */
const classificationChanged = (row: CatalogRow, next: AppClassification): boolean =>
  row.primaryCategory !== next.primaryCategory
  || !sameArray(row.categories, next.categories)
  || !sameArray(row.tags, next.tags)
  || !sameArray(row.aliases, next.aliases)

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

type Scan = {
  before: Map<string, number>
  after: Map<string, number>
  updates: ReclassifyUpdate[]
  total: number
}

const scanRow = (row: CatalogRow, scan: Scan): void => {
  scan.total += 1
  bump(scan.before, row.primaryCategory)

  if (!isReshelvable(row.primaryCategory)) {
    bump(scan.after, row.primaryCategory)
    return
  }

  const next = classifyRegistryApp(classifierInput(row))
  if (!classificationChanged(row, next)) {
    bump(scan.after, row.primaryCategory)
    return
  }

  bump(scan.after, next.primaryCategory)
  scan.updates.push({
    id: row.id,
    primaryCategory: next.primaryCategory,
    categories: next.categories,
    tags: next.tags,
    aliases: next.aliases,
  })
}

/** Read every `mcp_registry` row once, ordered by id so the cursor is stable. */
const scanRegistryApps = async (prisma: PrismaClient): Promise<Scan> => {
  const scan: Scan = { before: new Map(), after: new Map(), updates: [], total: 0 }
  let cursor: string | undefined

  for (;;) {
    const rows = (await prisma.mcpCatalogEntry.findMany({
      where: { appSource: 'mcp_registry' },
      select: ROW_SELECT,
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })) as CatalogRow[]

    if (rows.length === 0) break
    for (const row of rows) scanRow(row, scan)
    if (rows.length < PAGE_SIZE) break
    cursor = rows[rows.length - 1]?.id
  }

  return scan
}

const applyUpdates = async (
  prisma: PrismaClient,
  updates: readonly ReclassifyUpdate[],
): Promise<void> => {
  for (let start = 0; start < updates.length; start += UPDATE_CHUNK) {
    const chunk = updates.slice(start, start + UPDATE_CHUNK)
    await prisma.$transaction(
      chunk.map((update) =>
        prisma.mcpCatalogEntry.update({
          where: { id: update.id },
          data: {
            primaryCategory: update.primaryCategory,
            categories: update.categories,
            tags: update.tags,
            aliases: update.aliases,
          },
        }),
      ),
    )
  }
}

/** Distribution, densest shelf first, with `other`'s before→after always shown. */
const printDistribution = (scan: Scan): void => {
  const categories = new Set<string>([...scan.before.keys(), ...scan.after.keys()])
  const rows = [...categories]
    .map((category) => ({
      category,
      before: scan.before.get(category) ?? 0,
      after: scan.after.get(category) ?? 0,
    }))
    .sort((a, b) => b.after - a.after || a.category.localeCompare(b.category))

  console.log('Category distribution (before -> after):')
  for (const row of rows) {
    console.log(`  ${row.category.padEnd(20)} ${String(row.before).padStart(5)} -> ${row.after}`)
  }
  const otherBefore = scan.before.get('other') ?? 0
  const otherAfter = scan.after.get('other') ?? 0
  console.log(`Other: ${otherBefore} -> ${otherAfter} (-${otherBefore - otherAfter})`)
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } })
  const dryRun = values['dry-run'] === true

  const prisma = getPrismaClient()
  const startedAt = Date.now()

  try {
    console.log(
      dryRun
        ? 'Re-categorising ingested registry apps (dry run — no writes)...'
        : 'Re-categorising ingested registry apps...',
    )

    const scan = await scanRegistryApps(prisma)

    if (!dryRun) await applyUpdates(prisma, scan.updates)

    const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`
    const verb = dryRun ? 'would change' : 'changed'
    console.log(`Scanned ${scan.total} registry app(s) in ${elapsed}; ${verb} ${scan.updates.length}.`)
    printDistribution(scan)
  } finally {
    await disconnectPrismaClient()
  }
}

main().catch((error) => {
  console.error('Re-categorisation failed:', error)
  process.exitCode = 1
})
