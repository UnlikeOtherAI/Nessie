import { parseArgs } from 'node:util'

import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'
import { syncRegistry, type RegistrySyncProgress } from '@nessie/mcp-manage'

/**
 * CLI runner for the official MCP Registry ingestion. Invoke with:
 *   pnpm --filter @nessie/api sync:registry
 *   pnpm --filter @nessie/api sync:registry --max-pages 3
 *
 * This is the bulk path. The owner button (`POST /api/admin/mcp-registry/sync`)
 * starts the same sweep in the background of an API process, which is right for
 * a top-up and wrong for the first fill of an empty store: thousands of records
 * over dozens of pages is a terminal job, and a terminal job that prints nothing
 * for several minutes is indistinguishable from a hung one. So every page
 * reports as it lands, and the elapsed clock keeps ticking even on a page where
 * nothing turned out to be installable.
 */

const parseMaxPages = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-pages must be a positive integer, got "${raw}"`)
  }
  return value
}

const formatElapsed = (startedAt: number): string =>
  `${Math.round((Date.now() - startedAt) / 1000)}s`

const formatCounts = (progress: RegistrySyncProgress): string =>
  [
    `page ${progress.page}`,
    `fetched ${progress.serversFetched}`,
    `created ${progress.serversCreated}`,
    `updated ${progress.serversUpdated}`,
    `skipped ${progress.serversSkipped}`,
    `failed ${progress.serversFailed}`,
  ].join(' · ')

const main = async (): Promise<void> => {
  const { values } = parseArgs({ options: { 'max-pages': { type: 'string' } } })
  const maxPages = parseMaxPages(values['max-pages'])

  const prisma = getPrismaClient()
  const startedAt = Date.now()
  // A holder rather than a bare `let`: the closing line reports the numbers the
  // last page reported, and `serversSkipped` is a counter of the sweep rather
  // than a column on the run row, so it cannot be read back afterwards.
  const tracker: { latest: RegistrySyncProgress | null } = { latest: null }

  try {
    console.log(
      maxPages === undefined
        ? 'Syncing the official MCP Registry (full walk)...'
        : `Syncing the official MCP Registry (at most ${maxPages} page(s))...`,
    )

    const summary = await syncRegistry(prisma, {
      maxPages,
      onProgress: (progress: RegistrySyncProgress) => {
        tracker.latest = progress
        console.log(`  ${formatCounts(progress)} · ${formatElapsed(startedAt)}`)
      },
    })

    const latest = tracker.latest
    if (latest === null) {
      console.warn('The registry returned no pages. Nothing was ingested.')
      return
    }

    console.log(`Sync ${summary.runId} finished in ${formatElapsed(startedAt)}: ${formatCounts(latest)}.`)

    if (latest.serversFailed > 0) {
      // Per-record failures are expected and never fatal — the run row keeps a
      // capped sample, and `GET /api/admin/mcp-registry/sync-status` shows it.
      console.warn(
        `${latest.serversFailed} record(s) failed validation. `
        + 'Inspect them via GET /api/admin/mcp-registry/sync-status.',
      )
    }
  } finally {
    await disconnectPrismaClient()
  }
}

main().catch((error) => {
  console.error('Registry sync failed:', error)
  process.exitCode = 1
})
