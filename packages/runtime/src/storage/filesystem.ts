import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'

import { byteCounter, StreamingStorage } from './base.js'

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

export class FilesystemStorage extends StreamingStorage {
  private readonly baseDir: string

  constructor(baseDir: string) {
    super()
    this.baseDir = resolve(baseDir)
  }

  async putStream(
    key: string,
    body: Readable,
    _opts: { mime: string; abortSignal?: AbortSignal },
  ): Promise<{ bytesWritten: number }> {
    const fullPath = resolveSafePath(this.baseDir, key)
    await mkdir(dirname(fullPath), { recursive: true })
    const counter = byteCounter()
    await pipeline(body, counter.stream, createWriteStream(fullPath))
    return { bytesWritten: counter.bytes }
  }

  async getStream(key: string): Promise<Readable | null> {
    const fullPath = resolveSafePath(this.baseDir, key)
    try {
      await stat(fullPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    return createReadStream(fullPath)
  }

  async delete(key: string): Promise<void> {
    const fullPath = resolveSafePath(this.baseDir, key)
    await rm(fullPath, { force: true })
  }
}
