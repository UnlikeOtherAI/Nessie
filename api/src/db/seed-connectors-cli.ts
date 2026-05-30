import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'

import { seedPublicConnectors } from './seed-connectors.js'

/**
 * CLI runner for the public connector seed. Invoke with:
 *   pnpm --filter @nessie/api seed:connectors
 */
const main = async (): Promise<void> => {
  const prisma = getPrismaClient()
  try {
    const { seeded } = await seedPublicConnectors(prisma)
    console.log(`Seeded ${seeded} public connector(s) into the MCP App Store.`)
  } finally {
    await disconnectPrismaClient()
  }
}

main().catch((error) => {
  console.error('Connector seed failed:', error)
  process.exitCode = 1
})
