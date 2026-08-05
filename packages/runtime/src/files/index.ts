import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import type { Attachment, PrismaClient } from '@prisma/client'

import { type BudgetScope, checkStorageQuota, type StorageQuotaDecision } from '../budget.js'
import {
  currentStorageUsageBytes,
  type LedgerAttribution,
  recordStorageStored,
  type StorageUsageScope,
} from '../ledger.js'
import type { Storage } from '../storage/index.js'
import { isStrippableImageMime, prepareImageUpload } from './strip-image-metadata.js'
import { type GeneratedThumbnail, THUMBNAIL_MIME } from './thumbnail.js'

// Thumbnails live next to the object they describe, so a backend listing shows
// the pair together and a stray object is obviously derived.
const thumbnailStorageKey = (storageKey: string): string => `${storageKey}.thumb.webp`

// Swap in the preview's own identity (name/type/size) so download routes serve
// it — and derive its ETag from it — exactly like a first-class object.
const asThumbnailAttachment = (attachment: Attachment): Attachment => ({
  ...attachment,
  filename: `${attachment.filename.replace(/\.[^./\\]+$/, '')}.webp`,
  mime: attachment.thumbnailMime ?? THUMBNAIL_MIME,
  sizeBytes: attachment.thumbnailSizeBytes ?? 0n,
})

/**
 * The single chokepoint for blob file work. Everything that stores, streams,
 * or deletes a file goes through here so storage I/O, the Attachment table, and
 * the stored-bytes usage ledger stay in lockstep. Never call `storage.*` or
 * `prisma.attachment` for file bytes from anywhere else — usage accounting is
 * part of the file operation, not optional.
 *
 * Knowledge-base ROW creation (a KnowledgePage of kind=file plus its version)
 * stays in the knowledge provider; this service only owns the bytes those rows
 * point at. KB-aware scope is derived from the linked page so per-space/team
 * usage nets to zero on delete.
 *
 * Privacy: JPEG/PNG/WebP uploads have their EXIF/GPS metadata stripped here
 * (EXIF orientation applied to the pixels first, ICC profiles preserved), so
 * stored bytes never leak location/device data into multi-member workspaces.
 * Orgs can opt out via `Organization.stripImageMetadata`; accounting always
 * records the post-strip byte size. See ./strip-image-metadata.ts.
 *
 * Thumbnails: an attachment may own a second object, `<storageKey>.thumb.webp`,
 * so a feed can preview a file without transferring the original. It is a
 * derived artifact of the same file, which is exactly why it belongs here — the
 * quota gate covers it, it gets its own signed usage events, and `delete` frees
 * both objects. Every caller that deletes attachment bytes already routes
 * through this service, so nothing can leak a thumbnail by forgetting about it.
 */

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly usedBytes: bigint,
    readonly limitBytes: bigint | null,
  ) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

export class FileTooLargeError extends Error {
  constructor(
    readonly bytesWritten: number,
    readonly maxBytes: number,
  ) {
    super(`File exceeds the ${maxBytes}-byte upload limit (${bytesWritten} bytes)`)
    this.name = 'FileTooLargeError'
  }
}

// Derive a coarse attachment `kind` from the MIME type for cheap UI branching
// (inline preview vs. download) without re-parsing MIME everywhere.
export const kindFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

export type FileScope = {
  projectId?: string | null
  teamId?: string | null
  spaceId?: string | null
}

export type StoreFileInput = {
  attribution: LedgerAttribution
  organizationId: string
  uploaderId: string | null
  filename: string
  mime: string
  body: Readable
  scope?: FileScope
  messageId?: string | null
  knowledgePageId?: string | null
  width?: number | null
  height?: number | null
  abortSignal?: AbortSignal
}

// Async thumbnail generation (`attachment.thumbnail` worker job) reports back
// through setThumbnail: a rendered preview, or null when this file has none.
export type SetThumbnailInput = {
  attachmentId: string
  organizationId: string
  attribution: LedgerAttribution
  thumbnail: GeneratedThumbnail | null
}

export type FileService = {
  store(input: StoreFileInput): Promise<{ attachment: Attachment; bytesWritten: number }>
  openStream(
    attachmentId: string,
    organizationId: string,
  ): Promise<{ stream: Readable; attachment: Attachment } | null>
  // Bytes of the attachment's thumbnail, presented as an Attachment whose
  // mime/size/filename describe the preview — so download routes serve and
  // validate it exactly like any other object. Null when there is none.
  openThumbnailStream(
    attachmentId: string,
    organizationId: string,
  ): Promise<{ stream: Readable; attachment: Attachment } | null>
  // Attach (or definitively give up on) a thumbnail generated after the fact.
  // Idempotent: the first writer wins and a loser's object is cleaned up, so a
  // re-run can never double-count bytes.
  setThumbnail(input: SetThumbnailInput): Promise<boolean>
  delete(
    attachmentId: string,
    organizationId: string,
    attribution: LedgerAttribution,
    scope?: FileScope,
  ): Promise<boolean>
  // Free every stored object a knowledge page owns (its file-node version
  // attachments + drawer attachments) and decrement usage. Used when a page is
  // archived/deleted so storage accounting stays correct.
  purgeKnowledgePageFiles(
    pageId: string,
    organizationId: string,
    attribution: LedgerAttribution,
  ): Promise<void>
  checkQuota(scope: BudgetScope, addBytes: number | bigint): Promise<StorageQuotaDecision>
  currentUsage(scope: BudgetScope): Promise<{ usedBytes: bigint; limitBytes: bigint | null }>
  usageForScope(scope: StorageUsageScope): Promise<bigint>
}

export const createFileService = (deps: {
  prisma: PrismaClient
  storage: Storage
  maxUploadBytes: number
}): FileService => {
  const { prisma, storage, maxUploadBytes } = deps

  const budgetScope = (organizationId: string, scope?: FileScope): BudgetScope => ({
    organizationId,
    projectId: scope?.projectId ?? null,
    teamId: scope?.teamId ?? null,
  })

  // Org-level opt-out for EXIF/GPS stripping; defaults to stripping when the
  // org row is missing so privacy is the fail-safe posture.
  const shouldStripImageMetadata = async (organizationId: string): Promise<boolean> => {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { stripImageMetadata: true },
    })
    return org?.stripImageMetadata ?? true
  }

  // For delete accounting we must mirror the scope the store event used so the
  // per-space/team SUM nets to zero. If the attachment is a KB page attachment,
  // derive the scope from its page; otherwise fall back to org-only.
  const deriveScope = async (
    attachment: Attachment,
    override?: FileScope,
  ): Promise<StorageUsageScope> => {
    if (override) {
      return {
        organizationId: attachment.organizationId,
        projectId: override.projectId ?? null,
        teamId: override.teamId ?? null,
        spaceId: override.spaceId ?? null,
        uploaderId: attachment.uploaderId,
      }
    }
    if (attachment.knowledgePageId) {
      const page = await prisma.knowledgePage.findUnique({
        where: { id: attachment.knowledgePageId },
        select: { projectId: true, teamId: true, spaceId: true },
      })
      if (page) {
        return {
          organizationId: attachment.organizationId,
          projectId: page.projectId,
          teamId: page.teamId,
          spaceId: page.spaceId,
          uploaderId: attachment.uploaderId,
        }
      }
    }
    return { organizationId: attachment.organizationId, uploaderId: attachment.uploaderId }
  }

  const store: FileService['store'] = async (input) => {
    const scope = budgetScope(input.organizationId, input.scope)
    // Advisory pre-check: rejects when already over the cap before we read bytes.
    const pre = await checkStorageQuota(prisma, scope, 0)
    if (!pre.allowed) {
      throw new QuotaExceededError(pre.reason, pre.usedBytes, pre.limitBytes)
    }

    // Privacy: strip EXIF/GPS metadata from JPEG/PNG/WebP uploads (applying
    // EXIF orientation first) unless the org opted out. Accounting below
    // records the post-strip byte size. Oversized or undecodable images pass
    // through unchanged — see strip-image-metadata.ts.
    let body = input.body
    let width = input.width ?? null
    let height = input.height ?? null
    // Preview derived from the same buffered bytes the strip step already
    // holds — no second decode, no queued job for the common chat photo.
    let thumbnail: GeneratedThumbnail | null = null
    if (isStrippableImageMime(input.mime) && (await shouldStripImageMetadata(input.organizationId))) {
      const prepared = await prepareImageUpload(body)
      body = prepared.body
      thumbnail = prepared.thumbnail ?? null
      if (prepared.width !== null) {
        width = prepared.width
        height = prepared.height
      }
    }

    const storageKey = `${input.organizationId}/${randomUUID()}`
    let bytesWritten: number
    try {
      const result = await storage.putStream(storageKey, body, {
        mime: input.mime,
        abortSignal: input.abortSignal,
      })
      bytesWritten = result.bytesWritten
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined)
      throw error
    }

    if (bytesWritten > maxUploadBytes) {
      await storage.delete(storageKey).catch(() => undefined)
      throw new FileTooLargeError(bytesWritten, maxUploadBytes)
    }

    // Authoritative quota re-check now that the exact size is known. The
    // thumbnail counts against the same budget — it is stored bytes like any
    // other — so it can never push an org over the cap after the fact.
    const thumbnailBytes = thumbnail?.data.byteLength ?? 0
    const post = await checkStorageQuota(prisma, scope, bytesWritten + thumbnailBytes)
    if (!post.allowed) {
      await storage.delete(storageKey).catch(() => undefined)
      throw new QuotaExceededError(post.reason, post.usedBytes, post.limitBytes)
    }

    // Write the preview before the row so the row is never created pointing at
    // an object that does not exist. A failed preview write is not fatal: the
    // upload succeeds without one.
    const thumbnailKey = thumbnail ? thumbnailStorageKey(storageKey) : null
    let storedThumbnail: GeneratedThumbnail | null = null
    if (thumbnail && thumbnailKey) {
      try {
        await storage.put(thumbnailKey, thumbnail.data, THUMBNAIL_MIME)
        storedThumbnail = thumbnail
      } catch {
        await storage.delete(thumbnailKey).catch(() => undefined)
      }
    }

    let attachment: Attachment
    try {
      attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          uploaderId: input.uploaderId,
          messageId: input.messageId ?? null,
          knowledgePageId: input.knowledgePageId ?? null,
          kind: kindFromMime(input.mime),
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(bytesWritten),
          storageKey,
          width,
          height,
          thumbnailKey: storedThumbnail ? thumbnailKey : null,
          thumbnailMime: storedThumbnail ? storedThumbnail.mime : null,
          thumbnailSizeBytes: storedThumbnail ? BigInt(storedThumbnail.data.byteLength) : null,
          thumbnailWidth: storedThumbnail?.width ?? null,
          thumbnailHeight: storedThumbnail?.height ?? null,
          thumbnailStatus: storedThumbnail ? 'ready' : null,
        },
      })
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined)
      if (thumbnailKey) {
        await storage.delete(thumbnailKey).catch(() => undefined)
      }
      throw error
    }

    const usageScope = {
      organizationId: input.organizationId,
      projectId: input.scope?.projectId ?? null,
      teamId: input.scope?.teamId ?? null,
      spaceId: input.scope?.spaceId ?? null,
      uploaderId: input.uploaderId,
    }
    await recordStorageStored(prisma, {
      attribution: input.attribution,
      scope: usageScope,
      deltaBytes: BigInt(bytesWritten),
      operation: 'store',
      attachmentId: attachment.id,
    })
    if (storedThumbnail) {
      // A separate signed event, not a larger `store`: usage sums every row, so
      // the preview's bytes stay individually auditable and its later `-bytes`
      // counterpart nets it to zero.
      await recordStorageStored(prisma, {
        attribution: input.attribution,
        scope: usageScope,
        deltaBytes: BigInt(storedThumbnail.data.byteLength),
        operation: 'store.thumbnail',
        attachmentId: attachment.id,
      })
    }

    return { attachment, bytesWritten }
  }

  const openStream: FileService['openStream'] = async (attachmentId, organizationId) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!attachment || attachment.organizationId !== organizationId) {
      return null
    }
    const stream = await storage.getStream(attachment.storageKey)
    if (!stream) {
      return null
    }
    return { stream, attachment }
  }

  const deleteFile: FileService['delete'] = async (
    attachmentId,
    organizationId,
    attribution,
    scope,
  ) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!attachment || attachment.organizationId !== organizationId) {
      return false
    }
    const usageScope = await deriveScope(attachment, scope)
    // Delete the row first so a re-delete is a clean no-op, then the objects
    // (best-effort — a missing object is harmless), then the negative deltas.
    // The thumbnail is freed here and nowhere else: every caller that deletes
    // attachment bytes goes through this function, so one place covers them all.
    await prisma.attachment.delete({ where: { id: attachment.id } })
    await storage.delete(attachment.storageKey).catch(() => undefined)
    if (attachment.thumbnailKey) {
      await storage.delete(attachment.thumbnailKey).catch(() => undefined)
    }
    await recordStorageStored(prisma, {
      attribution,
      scope: usageScope,
      deltaBytes: -attachment.sizeBytes,
      operation: 'delete',
      attachmentId: attachment.id,
    })
    if (attachment.thumbnailKey && attachment.thumbnailSizeBytes) {
      await recordStorageStored(prisma, {
        attribution,
        scope: usageScope,
        deltaBytes: -attachment.thumbnailSizeBytes,
        operation: 'delete.thumbnail',
        attachmentId: attachment.id,
      })
    }
    return true
  }

  const openThumbnailStream: FileService['openThumbnailStream'] = async (
    attachmentId,
    organizationId,
  ) => {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!attachment || attachment.organizationId !== organizationId || !attachment.thumbnailKey) {
      return null
    }
    const stream = await storage.getStream(attachment.thumbnailKey)
    if (!stream) {
      return null
    }
    return { stream, attachment: asThumbnailAttachment(attachment) }
  }

  const setThumbnail: FileService['setThumbnail'] = async (input) => {
    const attachment = await prisma.attachment.findUnique({
      where: { id: input.attachmentId },
    })
    if (!attachment || attachment.organizationId !== input.organizationId) {
      return false
    }
    if (!input.thumbnail) {
      // Definitively no preview for this file. Recorded so the client stops
      // asking and a retry does not re-render it.
      await prisma.attachment.updateMany({
        where: { id: attachment.id, thumbnailKey: null },
        data: { thumbnailStatus: 'unavailable' },
      })
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
      await prisma.attachment.updateMany({
        where: { id: attachment.id, thumbnailKey: null },
        data: { thumbnailStatus: 'unavailable' },
      })
      return false
    }

    const key = thumbnailStorageKey(attachment.storageKey)
    await storage.put(key, input.thumbnail.data, input.thumbnail.mime)
    // Conditional on thumbnailKey still being null: if a concurrent writer won,
    // this claims nothing, and the object written above is dropped rather than
    // counted. Accounting only follows a claim, so bytes can never double-count.
    const claimed = await prisma.attachment.updateMany({
      where: { id: attachment.id, thumbnailKey: null },
      data: {
        thumbnailKey: key,
        thumbnailMime: input.thumbnail.mime,
        thumbnailSizeBytes: BigInt(bytes),
        thumbnailWidth: input.thumbnail.width,
        thumbnailHeight: input.thumbnail.height,
        thumbnailStatus: 'ready',
      },
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
  }

  const purgeKnowledgePageFiles: FileService['purgeKnowledgePageFiles'] = async (
    pageId,
    organizationId,
    attribution,
  ) => {
    const page = await prisma.knowledgePage.findUnique({
      where: { id: pageId },
      select: { projectId: true, teamId: true, spaceId: true },
    })
    const scope: FileScope | undefined = page
      ? { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId }
      : undefined
    const pageAttachments = await prisma.attachment.findMany({
      where: { knowledgePageId: pageId, organizationId },
      select: { id: true },
    })
    for (const attachment of pageAttachments) {
      await deleteFile(attachment.id, organizationId, attribution, scope)
    }
    const versions = await prisma.knowledgePageVersion.findMany({
      where: { pageId, attachmentId: { not: null } },
      select: { attachmentId: true },
    })
    for (const version of versions) {
      if (version.attachmentId) {
        await deleteFile(version.attachmentId, organizationId, attribution, scope)
      }
    }
  }

  return {
    store,
    openStream,
    openThumbnailStream,
    setThumbnail,
    delete: deleteFile,
    purgeKnowledgePageFiles,
    checkQuota: (scope, addBytes) => checkStorageQuota(prisma, scope, addBytes),
    currentUsage: async (scope) => {
      const decision = await checkStorageQuota(prisma, scope, 0)
      return { usedBytes: decision.usedBytes, limitBytes: decision.limitBytes }
    },
    usageForScope: (scope) => currentStorageUsageBytes(prisma, scope),
  }
}
