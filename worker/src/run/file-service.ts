import { loadConfig } from '@nessie/config'
import { createFileService, getStorage, type FileService } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

/**
 * The worker's handle on the single FileService chokepoint (storage bytes +
 * Attachment row + stored-bytes accounting), shared by every worker path that
 * touches attachment bytes: the `attachment_*` tools and the prompt builder
 * that inlines a message's images for the model.
 *
 * Built from config per call — the service is a stateless facade over prisma
 * and the storage backend — so nothing in the worker has a reason to reach for
 * `getStorage` or `prisma.attachment` on its own.
 */
export const fileServiceFor = (prisma: PrismaClient): FileService => {
  const config = loadConfig()
  return createFileService({
    prisma,
    storage: getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
  })
}
