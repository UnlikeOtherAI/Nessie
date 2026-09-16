import type { Attachment, PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from '../ledger.js'
import { recordStorageScopeMoved } from '../storage-usage-ledger.js'
import type { Storage } from '../storage/index.js'
// Type-only, so it is erased: no runtime cycle with ./index.js, which imports
// this module for the values.
import type { FileScope, StoreFileInput } from './index.js'

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

/**
 * Thrown by a declared-but-unbuilt file operation.
 *
 * Retained after Wave 1E filled both bodies because it is part of this
 * module's exported surface and a consumer may still be catching it; nothing
 * throws it now.
 */
export class FileTransferNotImplementedError extends Error {
  constructor(operation: 'copy' | 'reassignScope') {
    super(`FileService.${operation} is declared but not implemented yet`)
    this.name = 'FileTransferNotImplementedError'
  }
}

// The one part of `FileService` these operations genuinely need. Taking it as a
// dependency rather than importing `createFileService` keeps the cycle between
// this module and ./index.ts type-only: `store` is where the quota gate, the
// `store` ledger event and the thumbnail live, and a second path to any of them
// is exactly what this service exists to prevent.
export type FileTransferStore = (
  input: StoreFileInput,
) => Promise<{ attachment: Attachment; bytesWritten: number }>

// Same derivation `deleteFile` uses for its negative deltas, kept here because
// a move's two events must name the *page's* scope columns, not the caller's
// idea of them. `uploaderId` travels with the attachment so the per-uploader
// dimension nets to zero as well.
const usageScopeFor = (
  attachment: Pick<Attachment, 'organizationId' | 'uploaderId'>,
  scope: FileScope,
) => ({
  organizationId: attachment.organizationId,
  projectId: scope.projectId ?? null,
  teamId: scope.teamId ?? null,
  spaceId: scope.spaceId ?? null,
  uploaderId: attachment.uploaderId,
})

export const createFileTransferOps = (deps: {
  prisma: PrismaClient
  storage: Storage
  store: FileTransferStore
}): FileTransferOps => {
  const { prisma, storage, store } = deps

  const copy: FileTransferOps['copy'] = async (attachmentId, input) => {
    const source = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    // An attachment id that resolves to another organisation's row is
    // indistinguishable here from one that resolves to nothing, exactly as in
    // `openStream`.
    if (!source || source.organizationId !== input.organizationId) return null
    const stream = await storage.getStream(source.storageKey)
    if (!stream) return null

    // Straight through `store`: the quota decision, the `store` event in the
    // destination scope and the fresh thumbnail are all its job. The copy gets
    // its own object key, its own row and its own bytes — there is deliberately
    // no path here that reuses the source's `storageKey`.
    return store({
      attribution: input.attribution,
      organizationId: input.organizationId,
      uploaderId: input.uploaderId,
      filename: source.filename,
      mime: source.mime,
      body: stream,
      scope: input.scope,
      knowledgePageId: input.knowledgePageId ?? null,
      width: source.width,
      height: source.height,
    })
  }

  const reassignScope: FileTransferOps['reassignScope'] = async (attachmentIds, input) => {
    if (attachmentIds.length === 0) return { attachmentsMoved: 0, bytesMoved: 0n }
    const attachments = await prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        uploaderId: true,
        sizeBytes: true,
        thumbnailKey: true,
        thumbnailSizeBytes: true,
      },
    })

    let bytesMoved = 0n
    for (const attachment of attachments) {
      const from = usageScopeFor(attachment, input.from)
      const to = usageScopeFor(attachment, input.to)
      await recordStorageScopeMoved(prisma, {
        attribution: input.attribution,
        from,
        to,
        deltaBytes: attachment.sizeBytes,
        attachmentId: attachment.id,
      })
      bytesMoved += attachment.sizeBytes
      // A thumbnail is stored bytes like any other and carries its own signed
      // pair, so the preview follows its original into the new scope instead of
      // staying charged to the old one forever.
      if (attachment.thumbnailKey && attachment.thumbnailSizeBytes) {
        await recordStorageScopeMoved(prisma, {
          attribution: input.attribution,
          from,
          to,
          deltaBytes: attachment.thumbnailSizeBytes,
          attachmentId: attachment.id,
        })
        bytesMoved += attachment.thumbnailSizeBytes
      }
    }

    return { attachmentsMoved: attachments.length, bytesMoved }
  }

  return { copy, reassignScope }
}
