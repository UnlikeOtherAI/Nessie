import { join } from 'node:path'

import { type Storage, type StorageConfig } from './base.js'
import { FilesystemStorage } from './filesystem.js'
import { GcsStorage } from './gcs.js'
import { S3Storage } from './s3.js'

export {
  type Storage,
  type StorageConfig,
  byteCounter,
  collectStream,
  StreamingStorage,
} from './base.js'

const DEFAULT_LOCAL_PATH = '.nessie-storage'

export const getStorage = (config: StorageConfig): Storage => {
  switch (config.provider) {
    case 'filesystem':
      return new FilesystemStorage(
        config.localPath
          ? join(process.cwd(), config.localPath)
          : join(process.cwd(), DEFAULT_LOCAL_PATH),
      )
    case 'gcs': {
      if (!config.bucket) {
        throw new Error('gcs storage requires a bucket name')
      }
      if (!config.gcsClient) {
        throw new Error('gcs storage requires a configured GCS client')
      }
      return new GcsStorage(config.gcsClient, config.bucket)
    }
    case 's3':
      return new S3Storage(config)
    default: {
      const exhaustive: never = config.provider
      throw new Error(`Unknown storage provider: ${String(exhaustive)}`)
    }
  }
}
