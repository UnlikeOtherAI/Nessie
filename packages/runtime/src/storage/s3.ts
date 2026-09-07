import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
// Kept on the same `^3.1124` range as `client-s3` and `lib-storage` above, and
// that is not cosmetic: the presigner takes the client apart — its resolved
// endpoint, credentials and signer all come out of the client's config — so the
// two have to resolve to one `@smithy` generation. Letting them drift produced a
// `tsc` failure naming two identical-looking `HandlerExecutionContext` types
// from two copies of `@smithy/types`, which is what that error means.
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import {
  byteCounter,
  type SignedDownloadRequest,
  type StorageConfig,
  StreamingStorage,
} from './base.js'

const PART_SIZE = 8 * 1024 * 1024
const QUEUE_SIZE = 4

/**
 * A filename is echoed back inside `Content-Disposition`, so it has to survive
 * being put in a quoted-string: a `"` would end the parameter early and a
 * newline would end the header. Both are already impossible in a stored
 * filename — but this value is signed into a URL the store replays verbatim,
 * and a header the API no longer writes is one it can no longer sanitise at
 * send time, so the escaping happens where the signature is minted.
 */
const headerSafeFilename = (filename: string): string =>
  filename.replace(/[\r\n"\\]/g, '')

const isNotFound = (error: unknown): boolean => {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404
}

/**
 * S3-compatible backend. Production runs self-hosted MinIO, so `endpoint` +
 * `forcePathStyle` are required there; against real AWS S3 they are omitted.
 * Uploads stream via lib-storage's multipart `Upload`, which back-pressures the
 * source Readable — a 5 GB body uses only ~`PART_SIZE * QUEUE_SIZE` of memory.
 *
 * It is also the one backend that can hand a client the bytes directly:
 * `signedDownloadUrl` exists when — and only when — `publicEndpoint` says the
 * store has an address a client can reach.
 */
export class S3Storage extends StreamingStorage {
  private readonly client: S3Client

  private readonly bucket: string

  /**
   * Present only on a deployment that declared a client-reachable
   * `publicEndpoint`. Assigned in the constructor rather than declared as a
   * class method so that "this store cannot sign" is visible to a caller as an
   * absent method — the same shape `filesystem` has — instead of a method that
   * exists and always fails.
   */
  readonly signedDownloadUrl?: (
    key: string,
    request: SignedDownloadRequest,
  ) => Promise<string>

  constructor(config: StorageConfig) {
    super()
    if (!config.bucket) {
      throw new Error('s3 storage requires a bucket name')
    }
    this.bucket = config.bucket
    const credentials = config.accessKeyId && config.secretAccessKey
      ? {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        }
      : {}
    this.client = new S3Client({
      region: config.region ?? 'us-east-1',
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      ...credentials,
    })
    if (!config.publicEndpoint) {
      return
    }
    // A second client that differs from the one above in exactly one thing:
    // the endpoint. SigV4 covers the Host header, so a URL a browser can use
    // has to be signed against the address the browser will ask — signing with
    // the internal client and swapping the host afterwards produces a
    // signature the store rejects.
    const presignClient = new S3Client({
      region: config.region ?? 'us-east-1',
      endpoint: config.publicEndpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      ...credentials,
    })
    this.signedDownloadUrl = (key, request) =>
      getSignedUrl(
        presignClient,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          // Pinned into the signature: the store answers with the type and the
          // filename the API chose, and a holder of the URL cannot ask it for
          // anything else.
          ResponseContentType: request.mime,
          ResponseContentDisposition:
            `${request.disposition}; filename="${headerSafeFilename(request.filename)}"`,
        }),
        { expiresIn: request.expiresInSeconds },
      )
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
