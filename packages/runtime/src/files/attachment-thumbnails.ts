import type { Readable } from 'node:stream'

import type { Attachment, PrismaClient } from '@prisma/client'

import { checkStorageQuota } from '../budget.js'
import {
  type LedgerAttribution,
  recordStorageStored,
  type StorageUsageScope,
} from '../ledger.js'
import type { Storage } from '../storage/index.js'
import { type GeneratedThumbnail, THUMBNAIL_MIME } from './thumbnail.js'

/**
 * The lifecycle of an attachment's derived preview object: where it lives, how
 * it is served, and how it is attached after the fact by the
 * `attachment.thumbnail` worker job.
 *
 * Split out of the FileService itself but not independent of it — these
 * operations are constructed with the same prisma/storage/scope-derivation the
 * service uses, so a preview can never be written, served, or accounted for
 * outside the one chokepoint. Deletion deliberately stays in `delete()`: it
 * must happen in the same place the original is freed.
 */

// Thumbnails live next to the object they describe, so a backend listing shows
// the pair together and a stray object is obviously derived.
export const thumbnailStorageKey = (storageKey: string): string => `${storageKey}.thumb.webp`

// Swap in the preview's own identity (name/type/size) so download routes serve
// it — and derive its ETag from it — exactly like a first-class object.
export const asThumbnailAttachment = (attachment: Attachment): Attachment => ({
  ...attachment,
  filename: `${attachment.filename.replace(/\.[^./\\]+$/, '')}.webp`,
  mime: attachment.thumbnailMime ?? THUMBNAIL_MIME,
  sizeBytes: attachment.thumbnailSizeBytes ?? 0n,
})

// Column values that record a stored preview, shared by the inline store path
// and the async claim below so the two can never drift.
export const thumbnailColumns = (
  key: string,
  thumbnail: GeneratedThumbnail,
): {
  thumbnailKey: string
  thumbnailMime: string
  thumbnailSizeBytes: bigint
  thumbnailWidth: number
  thumbnailHeight: number
  thumbnailStatus: string
} => ({
  thumbnailKey: key,
  thumbnailMime: thumbnail.mime,
  thumbnailSizeBytes: BigInt(thumbnail.data.byteLength),
  thumbnailWidth: thumbnail.width,
  thumbnailHeight: thumbnail.height,
  thumbnailStatus: 'ready',
})

export type SetThumbnailInput = {
  attachmentId: string
  organizationId: string
  attribution: LedgerAttribution
  thumbnail: GeneratedThumbnail | null
}

export type ThumbnailOps = {
  openThumbnailStream(
    attachmentId: string,
    organizationId: string,
  ): Promise<{ stream: Readable; attachment: Attachment } | null>
  setThumbnail(input: SetThumbnailInput): Promise<boolean>
}

export const createThumbnailOps = (deps: {
  prisma: PrismaClient
  storage: Storage
  deriveScope: (attachment: Attachment) => Promise<StorageUsageScope>
}): ThumbnailOps => {
  const { prisma, storage, deriveScope } = deps

  const markUnavailable = async (attachmentId: string): Promise<void> => {
    // Conditional on there being no preview yet, so this can never blank a
    // thumbnail a concurrent writer just claimed.
    await prisma.attachment.updateMany({
      where: { id: attachmentId, thumbnailKey: null },
      data: { thumbnailStatus: 'unavailable' },
    })
  }

  return {
    openThumbnailStream: async (attachmentId, organizationId) => {
      const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
      if (
        !attachment
        || attachment.organizationId !== organizationId
        || !attachment.thumbnailKey
      ) {
        return null
      }
      const stream = await storage.getStream(attachment.thumbnailKey)
      if (!stream) {
        return null
      }
      return { stream, attachment: asThumbnailAttachment(attachment) }
    },

    setThumbnail: async (input) => {
      const attachment = await prisma.attachment.findUnique({
        where: { id: input.attachmentId },
      })
      if (!attachment || attachment.organizationId !== input.organizationId) {
        return false
      }
      if (!input.thumbnail) {
        // Definitively no preview for this file. Recorded so clients stop
        // asking and a retry does not re-render it.
        await markUnavailable(attachment.id)
        return true
      }
      if (attachment.thumbnailKey) {
        // Already has one — leave it and its accounting alone.
        return true
      }

      const usageScope = await deriveScope(attachment)
      const bytes = input.thumbnail.data.byteLength
      const quota = await checkStorageQuota(
        prisma,
        {
          organizationId: usageScope.organizationId,
          projectId: usageScope.projectId ?? null,
          teamId: usageScope.teamId ?? null,
        },
        bytes,
      )
      if (!quota.allowed) {
        await markUnavailable(attachment.id)
        return false
      }

      const key = thumbnailStorageKey(attachment.storageKey)
      await storage.put(key, input.thumbnail.data, input.thumbnail.mime)
      // Conditional on thumbnailKey still being null: if a concurrent writer
      // won, this claims nothing and the object written above is dropped rather
      // than counted. Accounting only follows a claim, so bytes never
      // double-count.
      const claimed = await prisma.attachment.updateMany({
        where: { id: attachment.id, thumbnailKey: null },
        data: thumbnailColumns(key, input.thumbnail),
      })
      if (claimed.count === 0) {
        await storage.delete(key).catch(() => undefined)
        return false
      }
      await recordStorageStored(prisma, {
        attribution: input.attribution,
        scope: usageScope,
        deltaBytes: BigInt(bytes),
        operation: 'store.thumbnail',
        attachmentId: attachment.id,
      })
      return true
    },
  }
}
