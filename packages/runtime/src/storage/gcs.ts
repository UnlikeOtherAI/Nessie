import { Readable } from 'node:stream'

import { GcsStorageProvider, type GcsStorageClient } from '../gcs-storage.js'
import { collectStream, StreamingStorage } from './base.js'

/**
 * Legacy GCS backend. It is retained for compatibility but is NOT a production
 * backend (production uses S3/MinIO, dev uses filesystem). The underlying
 * provider shim is buffer-only, so this path does not stream — keep large
 * uploads off GCS.
 */
export class GcsStorage extends StreamingStorage {
  private readonly provider: GcsStorageProvider

  constructor(client: GcsStorageClient, bucketName: string) {
    super()
    this.provider = new GcsStorageProvider(client, bucketName)
  }

  async putStream(
    key: string,
    body: Readable,
    opts: { mime: string; abortSignal?: AbortSignal },
  ): Promise<{ bytesWritten: number }> {
    const buffer = await collectStream(body)
    await this.provider.put(key, buffer, { contentType: opts.mime })
    return { bytesWritten: buffer.length }
  }

  async getStream(key: string): Promise<Readable | null> {
    const buffer = await this.provider.get(key)
    return buffer ? Readable.from(buffer) : null
  }

  async delete(key: string): Promise<void> {
    await this.provider.delete(key)
  }
}
