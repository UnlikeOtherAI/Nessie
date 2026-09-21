import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import type { LocalInferenceResult } from '@nessie/schemas'

const MAX_RECEIPTS = 8
const MAX_RESULT_BYTES = 512 * 1024
const RECEIPT_TTL_MS = 60 * 60 * 1_000

export type LocalInferenceResultReceipt = {
  attemptId: string
  dispatchFence: number
  result: LocalInferenceResult
}

type StoredReceipt = LocalInferenceResultReceipt & { expiresAt: string }

type EncryptedJournal = {
  ciphertext: string
  iv: string
  tag: string
  version: 1
}

export type LocalInferenceReceiptStorage = {
  read: () => Promise<EncryptedJournal | undefined>
  remove: () => Promise<void>
  write: (value: EncryptedJournal) => Promise<void>
}

export class LocalInferenceReceiptError extends Error {
  override readonly name = 'LocalInferenceReceiptError'

  constructor(readonly code: 'protected_storage_unavailable' | 'receipt_conflict' | 'receipt_limit_exceeded') {
    super(code)
  }
}

const resultSize = (result: LocalInferenceResult): number => Buffer.byteLength(JSON.stringify(result), 'utf8')

const receiptKey = (receipt: Pick<LocalInferenceResultReceipt, 'attemptId' | 'dispatchFence'>): string => (
  `${receipt.attemptId}:${receipt.dispatchFence}`
)

const parseStoredReceipts = (value: unknown): StoredReceipt[] => {
  if (!Array.isArray(value) || value.length > MAX_RECEIPTS) {
    throw new LocalInferenceReceiptError('protected_storage_unavailable')
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    const record = candidate as Partial<StoredReceipt>
    const dispatchFence = record.dispatchFence
    if (
      typeof record.attemptId !== 'string'
      || typeof dispatchFence !== 'number'
      || !Number.isSafeInteger(dispatchFence)
      || dispatchFence < 1
      || !record.result
      || typeof record.expiresAt !== 'string'
      || Number.isNaN(new Date(record.expiresAt).valueOf())
      || resultSize(record.result) > MAX_RESULT_BYTES
    ) {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    return {
      attemptId: record.attemptId,
      dispatchFence,
      expiresAt: record.expiresAt,
      result: record.result,
    }
  })
}

/**
 * A host-owned encrypted receipt cache. The caller must provide a key from a
 * platform protected, non-exportable store and a private persistence adapter;
 * this class intentionally cannot fall back to executor JSON state or memory.
 */
export class EncryptedLocalInferenceReceiptJournal {
  #loaded = false
  #records = new Map<string, StoredReceipt>()
  #serial = Promise.resolve()

  constructor(
    private readonly storage: LocalInferenceReceiptStorage,
    private readonly key: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (key.byteLength !== 32) throw new Error('Local inference receipt keys must be 32 bytes.')
  }

  get(receipt: Pick<LocalInferenceResultReceipt, 'attemptId' | 'dispatchFence'>): Promise<LocalInferenceResultReceipt | undefined> {
    return this.withLock(async () => {
      await this.load()
      await this.sweep()
      const stored = this.#records.get(receiptKey(receipt))
      return stored === undefined
        ? undefined
        : { attemptId: stored.attemptId, dispatchFence: stored.dispatchFence, result: structuredClone(stored.result) }
    })
  }

  pending(): Promise<LocalInferenceResultReceipt[]> {
    return this.withLock(async () => {
      await this.load()
      await this.sweep()
      return [...this.#records.values()].map(({ attemptId, dispatchFence, result }) => ({
        attemptId, dispatchFence, result: structuredClone(result),
      }))
    })
  }

  record(receipt: LocalInferenceResultReceipt): Promise<void> {
    return this.withLock(async () => {
      if (resultSize(receipt.result) > MAX_RESULT_BYTES) {
        throw new LocalInferenceReceiptError('receipt_limit_exceeded')
      }
      await this.load()
      await this.sweep()
      const key = receiptKey(receipt)
      const existing = this.#records.get(key)
      if (existing) {
        if (JSON.stringify(existing.result) === JSON.stringify(receipt.result)) return
        throw new LocalInferenceReceiptError('receipt_conflict')
      }
      if (this.#records.size >= MAX_RECEIPTS) {
        throw new LocalInferenceReceiptError('receipt_limit_exceeded')
      }
      this.#records.set(key, {
        ...structuredClone(receipt),
        expiresAt: new Date(this.now().valueOf() + RECEIPT_TTL_MS).toISOString(),
      })
      await this.persist()
    })
  }

  acknowledge(receipt: Pick<LocalInferenceResultReceipt, 'attemptId' | 'dispatchFence'>): Promise<void> {
    return this.withLock(async () => {
      await this.load()
      await this.sweep()
      if (this.#records.delete(receiptKey(receipt))) await this.persist()
    })
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(task, task)
    this.#serial = next.then(() => undefined, () => undefined)
    return next
  }

  private async load(): Promise<void> {
    if (this.#loaded) return
    let encrypted: EncryptedJournal | undefined
    try {
      encrypted = await this.storage.read()
    } catch {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
    if (encrypted !== undefined) {
      if (encrypted.version !== 1) throw new LocalInferenceReceiptError('protected_storage_unavailable')
      let bytes: Buffer
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'))
        bytes = Buffer.concat([
          decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
          decipher.final(),
        ])
      } catch {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
      try {
        for (const receipt of parseStoredReceipts(JSON.parse(bytes.toString('utf8')) as unknown)) {
          this.#records.set(receiptKey(receipt), receipt)
        }
      } catch {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
    }
    this.#loaded = true
  }

  private async sweep(): Promise<void> {
    const now = this.now().valueOf()
    let changed = false
    for (const [key, receipt] of this.#records) {
      if (new Date(receipt.expiresAt).valueOf() <= now) {
        this.#records.delete(key)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  private async persist(): Promise<void> {
    if (this.#records.size === 0) {
      try {
        await this.storage.remove()
        return
      } catch {
        throw new LocalInferenceReceiptError('protected_storage_unavailable')
      }
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const plaintext = Buffer.from(JSON.stringify([...this.#records.values()]))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    try {
      await this.storage.write({
        ciphertext: ciphertext.toString('base64url'),
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        version: 1,
      })
    } catch {
      throw new LocalInferenceReceiptError('protected_storage_unavailable')
    }
  }
}
