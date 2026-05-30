import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { GcsStorageProvider, type GcsStorageClient } from '../gcs-storage.js'

/**
 * Minimal blob storage abstraction for the file-upload / attachments slice.
 * Backends are selected from `NessieConfig.storage.provider`:
 *   - `filesystem` (default) — writes under a configured base directory.
 *   - `gcs` — reuses the existing GCS implementation.
 *   - `s3` — explicitly unimplemented (throws, never silently falls back).
 */
export type Storage = {
  put(key: string, bytes: Buffer, mime: string): Promise<void>
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

export type StorageConfig = {
  provider: 'filesystem' | 'gcs' | 's3'
  bucket?: string
  localPath?: string
  gcsClient?: GcsStorageClient
}

const DEFAULT_LOCAL_PATH = '.nessie-storage'

// Reject keys that would escape the storage base directory (path traversal).
const resolveSafePath = (baseDir: string, key: string): string => {
  const normalizedKey = normalize(key).replace(/^([.][.](\/|\\|$))+/, '')
  if (isAbsolute(normalizedKey)) {
    throw new Error(`Invalid storage key (absolute path not allowed): ${key}`)
  }

  const fullPath = resolve(baseDir, normalizedKey)
  const baseResolved = resolve(baseDir)
  if (fullPath !== baseResolved && !fullPath.startsWith(baseResolved + sep)) {
    throw new Error(`Invalid storage key (path traversal): ${key}`)
  }

  return fullPath
}

class FilesystemStorage implements Storage {
  private readonly baseDir: string

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir)
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const fullPath = resolveSafePath(this.baseDir, key)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, bytes)
  }

  async get(key: string): Promise<Buffer | null> {
    const fullPath = resolveSafePath(this.baseDir, key)
    try {
      return await readFile(fullPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    const fullPath = resolveSafePath(this.baseDir, key)
    await rm(fullPath, { force: true })
  }
}

class GcsStorage implements Storage {
  private readonly provider: GcsStorageProvider

  constructor(client: GcsStorageClient, bucketName: string) {
    this.provider = new GcsStorageProvider(client, bucketName)
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.provider.put(key, bytes, { contentType: mime })
  }

  get(key: string): Promise<Buffer | null> {
    return this.provider.get(key)
  }

  delete(key: string): Promise<void> {
    return this.provider.delete(key)
  }
}

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
      throw new Error('s3 storage not yet implemented')
    default: {
      const exhaustive: never = config.provider
      throw new Error(`Unknown storage provider: ${String(exhaustive)}`)
    }
  }
}
