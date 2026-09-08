import { pathToFileURL } from 'node:url'
import { loadConfig } from '@nessie/config'
import { createModelClient } from '@nessie/runtime'
import { PrismaClient } from '@prisma/client'
import { backfillMessageEmbeddings } from './message-embedding-backfill.js'

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const organizationId = option('--organization-id')
if (!organizationId) throw new Error('--organization-id is required to keep this backfill tenant-bounded')
const limit = option('--limit')
const parsedLimit = limit ? Number(limit) : undefined
if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
  throw new Error('--limit must be a positive integer')
}

const run = async (): Promise<void> => {
  const config = loadConfig()
  const prisma = new PrismaClient()
  const modelClient = createModelClient(config.model, { embedding: config.embedding })
  try {
    const result = await backfillMessageEmbeddings(prisma, {
      cursor: option('--cursor'),
      embeddingModel: modelClient.embeddingModel,
      limit: parsedLimit,
      organizationId,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    modelClient.close()
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run()
}
