import { PrismaClient } from '@prisma/client'

import { seedPublicConnectors } from './seed-connectors.js'

/**
 * CLI runner for the public connector seed. Invoke with:
 *   pnpm --filter @nessie/api seed:connectors
 */
const main = async (): Promise<void> => {
  const prisma = new PrismaClient()
  try {
    const { seeded } = await seedPublicConnectors(prisma)
    console.log(`Seeded ${seeded} public connector(s) into the MCP App Store.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error('Connector seed failed:', error)
  process.exitCode = 1
})
