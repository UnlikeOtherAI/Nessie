import { pathToFileURL } from 'node:url'
import { loadConfig } from '@nessie/config'
import { createFileService, createModelClient, getStorage } from '@nessie/runtime'
import { PrismaClient } from '@prisma/client'
import { backfillMarkdownProjections } from './knowledge-markdown-backfill.js'

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const limit = option('--limit')
const parsedLimit = limit ? Number(limit) : undefined
if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
  throw new Error('--limit must be a positive integer')
}
const organizationId = option('--organization-id')
if (!organizationId) {
  throw new Error('--organization-id is required to keep this repair tenant-bounded')
}

const run = async (): Promise<void> => {
  const config = loadConfig()
  const prisma = new PrismaClient()
  const files = createFileService({
    maxUploadBytes: config.storage.maxUploadBytes,
    prisma,
    signedDownloadMinBytes: config.storage.signedDownloadMinBytes,
    storage: getStorage(config.storage),
  })
  const modelClient = createModelClient(config.model, { embedding: config.embedding })
  try {
    const result = await backfillMarkdownProjections({
      embeddingModel: modelClient.embeddingModel,
      prisma,
      readMarkdownAttachment: async (attachmentId, organizationId) => {
        const opened = await files.openStream(attachmentId, organizationId)
        return opened?.stream ?? null
      },
    }, { cursor: option('--cursor'), limit: parsedLimit, organizationId })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    modelClient.close()
    await prisma.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run()
}
