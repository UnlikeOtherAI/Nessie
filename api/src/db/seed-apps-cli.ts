import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'

import { seedAppStoreListings } from './seed-apps.js'

/**
 * CLI runner for the App Store presentation seed. Invoke with:
 *   pnpm --filter @nessie/api seed:apps
 */
const main = async (): Promise<void> => {
  const prisma = getPrismaClient()
  try {
    const { enriched, missing } = await seedAppStoreListings(prisma)
    console.log(`Enriched ${enriched} App Store listing(s).`)
    if (missing.length > 0) {
      // The seed enriches, never creates, so a missing row is an ordering
      // problem the operator can fix rather than a failure.
      console.warn(
        `No catalog entry found for: ${missing.join(', ')}. `
        + 'Run `pnpm --filter @nessie/api seed:connectors` first, then re-run this seed.',
      )
    }
  } finally {
    await disconnectPrismaClient()
  }
}

main().catch((error) => {
  console.error('App Store seed failed:', error)
  process.exitCode = 1
})
