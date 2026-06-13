import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

import { byteCounter, StreamingStorage, type StorageConfig } from './base.js'

const PART_SIZE = 8 * 1024 * 1024
const QUEUE_SIZE = 4

const isNotFound = (error: unknown): boolean => {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404
}

/**
 * S3-compatible backend. Production runs self-hosted MinIO, so `endpoint` +
 * `forcePathStyle` are required there; against real AWS S3 they are omitted.
 * Uploads stream via lib-storage's multipart `Upload`, which back-pressures the
 * source Readable — a 5 GB body uses only ~`PART_SIZE * QUEUE_SIZE` of memory.
 */
export class S3Storage extends StreamingStorage {
  private readonly client: S3Client

  private readonly bucket: string

  constructor(config: StorageConfig) {
    super()
    if (!config.bucket) {
      throw new Error('s3 storage requires a bucket name')
    }
    this.bucket = config.bucket
    this.client = new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    })
  }

  async putStream(
    key: string,
    body: Readable,
    opts: { mime: string; abortSignal?: AbortSignal },
  ): Promise<{ bytesWritten: number }> {
    const counter = byteCounter()
    // Forward source errors onto the counted stream so the Upload rejects
    // instead of hanging, then pipe through to tally bytes.
    body.on('error', (err) => counter.stream.destroy(err))
    body.pipe(counter.stream)

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: counter.stream,
        ContentType: opts.mime,
      },
      partSize: PART_SIZE,
      queueSize: QUEUE_SIZE,
      leavePartsOnError: false,
    })
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => {
        void upload.abort()
      })
    }
    await upload.done()
    return { bytesWritten: counter.bytes }
  }

  async getStream(key: string): Promise<Readable | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )
      // In Node the SDK returns a Readable for Body.
      return (result.Body as Readable | undefined) ?? null
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    )
  }
}
