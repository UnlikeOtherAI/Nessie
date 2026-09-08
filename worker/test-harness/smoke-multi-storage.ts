import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { getStorage } from '@nessie/runtime'

/** Proves the common object store before replicas start using it. */
export const assertSharedStorageReachable = async (input: {
  accessKeyId: string
  bucket: string
  endpoint: string
  secretAccessKey: string
}): Promise<void> => {
  const storage = getStorage({
    accessKeyId: input.accessKeyId,
    bucket: input.bucket,
    endpoint: input.endpoint,
    forcePathStyle: true,
    maxUploadBytes: 5 * 1024 * 1024 * 1024,
    provider: 's3',
    region: 'us-east-1',
    secretAccessKey: input.secretAccessKey,
  })
  const key = `smoke-multi/preflight-${randomUUID()}`
  try {
    await storage.putStream(key, Readable.from([Buffer.from('preflight')]), 'text/plain')
    const read = await storage.getStream(key)
    if (!read) throw new Error('the object could not be read back')
    read.destroy()
    await storage.delete(key)
  } catch (error) {
    throw new Error(
      `Shared object storage is not usable at ${input.endpoint}/${input.bucket}`
      + ` (${error instanceof Error ? error.message : String(error)}). Two instances`
      + ' must share one bucket; start it with `docker compose -f'
      + ' infrastructure/compose/docker-compose.multi.yml up -d minio minio-setup`,'
      + ' or point SMOKE_MULTI_STORAGE_ENDPOINT at your own S3-compatible endpoint.',
      { cause: error },
    )
  }
}