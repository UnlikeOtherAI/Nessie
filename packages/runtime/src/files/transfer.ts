import type { Attachment, PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from '../ledger.js'
import type { Storage } from '../storage/index.js'
// Type-only, so it is erased: no runtime cycle with ./index.js, which imports
// this module for the values.
import type { FileScope } from './index.js'

/**
 * The two file operations a cross-space transfer needs, declared apart from
 * the rest of `FileService` only because `./index.ts` is already at its size
 * limit — they are part of the same service and the same chokepoint, and
 * `createFileService` mixes them into the object it returns.
 *
 * Both exist because `docs/standards/file-storage.md` makes accounting part of
 * the file operation: a caller that re-stored bytes or re-homed a scope on its
 * own would have to write `StorageUsageEvent` rows itself, which nothing
 * outside this service may do.
 *
 * The bodies land in Wave 1E. Until then they throw, loudly and by name, so a
 * caller wired up early fails where it called rather than silently writing
 * nothing.
 */
export type FileTransferOps = {
  /**
   * Re-store one attachment's bytes as a new attachment in another scope.
   *
   * A copied knowledge page must not point at the source's `Attachment` row: a
   * purge on either page would delete bytes the other still shows, the ledger
   * would count one blob in one scope while two pages claim it, and
   * `Attachment` carries no reference count to make sharing safe. Re-storing
   * costs storage; that is what a copy is.
   *
   * Streams `openStream` into `store`, so the quota gate (507
   * `STORAGE_QUOTA_EXCEEDED`), the `store` ledger event in the destination
   * scope and a fresh thumbnail all happen at the one chokepoint. Returns null
   * when the source attachment does not belong to the organisation.
   */
  copy(
    attachmentId: string,
    input: {
      organizationId: string
      uploaderId: string | null
      scope: FileScope
      knowledgePageId?: string | null
      attribution: LedgerAttribution
    },
  ): Promise<{ attachment: Attachment; bytesWritten: number } | null>
  /**
   * Re-home accounted bytes after a cross-space move.
   *
   * The bytes stay exactly where they are; their scope changes. Per-space and
   * per-project usage is the sum of the ledger's events, so a move that wrote
   * none would leave the old scope charged forever and the new one free.
   * Writes one `move.out` (negative) event in `from` and one `move.in`
   * (positive) event in `to` per attachment, thumbnails included — the same
   * pairing `delete.thumbnail`/`store.thumbnail` already uses.
   *
   * No quota check runs: the pair sums to zero, so the organisation total is
   * unchanged by construction.
   */
  reassignScope(
    attachmentIds: string[],
    input: {
      organizationId: string
      from: FileScope
      to: FileScope
      attribution: LedgerAttribution
    },
  ): Promise<{ attachmentsMoved: number; bytesMoved: bigint }>
}

/** Thrown by a declared-but-unbuilt file operation. Wave 1E removes both. */
export class FileTransferNotImplementedError extends Error {
  constructor(operation: 'copy' | 'reassignScope') {
    super(`FileService.${operation} is declared but not implemented yet`)
    this.name = 'FileTransferNotImplementedError'
  }
}

export const createFileTransferOps = (_deps: {
  prisma: PrismaClient
  storage: Storage
}): FileTransferOps => ({
  copy: () => {
    throw new FileTransferNotImplementedError('copy')
  },
  reassignScope: () => {
    throw new FileTransferNotImplementedError('reassignScope')
  },
})
