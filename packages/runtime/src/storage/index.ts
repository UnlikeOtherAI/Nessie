import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { type Storage, type StorageConfig } from './base.js'
import { FilesystemStorage } from './filesystem.js'
import { GcsStorage } from './gcs.js'
import { S3Storage } from './s3.js'

export {
  type SignedDownloadRequest,
  type Storage,
  type StorageConfig,
  byteCounter,
  collectStream,
  StreamingStorage,
} from './base.js'

/**
 * Only reached by a `StorageConfig` built without a `localPath` — the config
 * loader always supplies one, and owns the real default. It is kept identical
 * to that one on purpose: when the two were `.nessie-storage` here and
 * `.nessie/storage` there, they were two different stores a mistake away.
 * `scripts/lint-local-state-paths.mjs` holds them together.
 */
const DEFAULT_LOCAL_PATH = join(homedir(), '.nessie', 'storage')

export const getStorage = (config: StorageConfig): Storage => {
  switch (config.provider) {
    case 'filesystem':
      // `resolve`, not `join`: the configured path is absolute in local mode
      // (it has to outlive the working tree the API was started from), and
      // `join` would have pasted it onto the working directory instead. A
      // relative path — which is what the tests pass — still resolves against
      // the working directory exactly as before.
      return new FilesystemStorage(
        resolve(process.cwd(), config.localPath ?? DEFAULT_LOCAL_PATH),
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
