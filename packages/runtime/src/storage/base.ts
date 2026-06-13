import { Readable, Transform } from 'node:stream'

import type { GcsStorageClient } from '../gcs-storage.js'

/**
 * Blob storage abstraction for the file-upload / attachments slice.
 *
 * The streaming methods (`putStream`/`getStream`) are the load-bearing API —
 * uploads can be up to 5 GB, so callers must never buffer a whole file in
 * memory. `put`/`get` (Buffer) remain as thin convenience wrappers for the few
 * small callers (avatars, brand logo, the worker base64 tool); they are
 * implemented in terms of the streaming methods by {@link StreamingStorage}.
 *
 * Backends are selected from `NessieConfig.storage.provider`:
 *   - `filesystem` (default) — writes under a configured base directory.
 *   - `s3` — S3-compatible object storage (production uses self-hosted MinIO).
 *   - `gcs` — legacy buffered path; retained but not used in production.
 */
export type Storage = {
  putStream(
    key: string,
    body: Readable,
    opts: { mime: string; abortSignal?: AbortSignal },
  ): Promise<{ bytesWritten: number }>
  getStream(key: string): Promise<Readable | null>
  put(key: string, bytes: Buffer, mime: string): Promise<void>
  get(key: string): Promise<Buffer | null>
  delete(key: string): Promise<void>
}

export type StorageConfig = {
  provider: 'filesystem' | 'gcs' | 's3'
  bucket?: string
  localPath?: string
  gcsClient?: GcsStorageClient
  endpoint?: string
  region?: string
  forcePathStyle?: boolean
  accessKeyId?: string
  secretAccessKey?: string
}

/** A pass-through Transform that tallies the bytes flowing through it. */
export const byteCounter = (): { stream: Transform; readonly bytes: number } => {
  let bytes = 0
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      bytes += chunk.length
      cb(null, chunk)
    },
  })
  return {
    stream,
    get bytes(): number {
      return bytes
    },
  }
}

/** Drain a Readable into a single Buffer (only for known-small objects). */
export const collectStream = async (readable: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk))
    } else {
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
  }
  return Buffer.concat(chunks)
}

/**
 * Base class wiring the Buffer `put`/`get` convenience methods to the streaming
 * primitives so each backend only implements `putStream`/`getStream`/`delete`.
 */
export abstract class StreamingStorage implements Storage {
  abstract putStream(
    key: string,
    body: Readable,
    opts: { mime: string; abortSignal?: AbortSignal },
  ): Promise<{ bytesWritten: number }>

  abstract getStream(key: string): Promise<Readable | null>

  abstract delete(key: string): Promise<void>

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    await this.putStream(key, Readable.from(bytes), { mime })
  }

  async get(key: string): Promise<Buffer | null> {
    const stream = await this.getStream(key)
    return stream ? collectStream(stream) : null
  }
}
