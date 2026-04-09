export type GcsFile = {
  name: string
  metadata: Record<string, string>
}

export type GcsBucket = {
  file(name: string): GcsFileHandle
  getFiles(query?: { prefix?: string; maxResults?: number }): Promise<[GcsFile[]]>
}

export type GcsFileHandle = {
  save(data: Buffer | string, options?: { contentType?: string; metadata?: Record<string, string> }): Promise<void>
  download(): Promise<[Buffer]>
  delete(options?: { ignoreNotFound?: boolean }): Promise<void>
  exists(): Promise<[boolean]>
  getMetadata(): Promise<[{ name: string; size: string; contentType: string; updated: string }]>
}

export type GcsStorageClient = {
  bucket(name: string): GcsBucket
}

export type StorageObject = {
  key: string
  data: Buffer
  contentType?: string
  metadata?: Record<string, string>
}

export type ListResult = {
  keys: string[]
}

export interface StorageProvider {
  delete(key: string): Promise<void>
  get(key: string): Promise<Buffer | null>
  list(prefix?: string): Promise<ListResult>
  put(key: string, data: Buffer | string, options?: { contentType?: string }): Promise<void>
}

export class GcsStorageProvider implements StorageProvider {
  private readonly bucket: GcsBucket

  constructor(client: GcsStorageClient, bucketName: string) {
    this.bucket = client.bucket(bucketName)
  }

  async put(
    key: string,
    data: Buffer | string,
    options?: { contentType?: string },
  ): Promise<void> {
    const file = this.bucket.file(key)
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data

    await file.save(buffer, {
      contentType: options?.contentType ?? 'application/octet-stream',
    })
  }

  async get(key: string): Promise<Buffer | null> {
    const file = this.bucket.file(key)

    const [exists] = await file.exists()
    if (!exists) {
      return null
    }

    const [contents] = await file.download()
    return contents
  }

  async delete(key: string): Promise<void> {
    const file = this.bucket.file(key)
    await file.delete({ ignoreNotFound: true })
  }

  async list(prefix?: string): Promise<ListResult> {
    const [files] = await this.bucket.getFiles(
      prefix ? { prefix } : undefined,
    )

    return {
      keys: files.map((f) => f.name),
    }
  }
}
