import type { Readable } from 'node:stream'
import type { PrismaClient } from '@prisma/client'
import {
  type FileService,
  isThumbnailableMime,
  type LedgerAttribution,
  renderThumbnail,
} from '@nessie/runtime'
import type { AttachmentThumbnailJobPayload } from '@nessie/schemas'

// `attachment.thumbnail` worker handler — the async half of the attachment
// preview pipeline. Everything a raster image upload can do inline (at the
// FileService store chokepoint, from bytes already buffered for EXIF
// stripping) is done there; this job covers what that path cannot:
//   - PDFs (first page rasterized via PDFium/WASM),
//   - animated or exotic images (GIF/AVIF/TIFF/SVG),
//   - images above the strip threshold or in orgs that opted out of stripping.
//
// Modelled on knowledge-extract.ts: re-open the stored bytes through the
// FileService under a hard size guard, do bounded work, write back. The result
// is handed to `fileService.setThumbnail`, which owns the storage write, the
// quota gate, and the usage event — this handler never touches storage.

// Rendering needs the whole blob buffered, so a byte cap keeps memory bounded
// regardless of kind. Above it, a file simply has no preview: the point of a
// thumbnail is to avoid moving large bytes, not to justify it.
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

const readStreamCapped = async (
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | null> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > maxBytes) {
      // The row said it fit; the object disagrees. Stop rather than buffer on.
      stream.destroy()
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

type AttachmentThumbnailDeps = {
  fileService: FileService
  prisma: PrismaClient
}

export const executeAttachmentThumbnailJob = async (
  deps: AttachmentThumbnailDeps,
  payload: AttachmentThumbnailJobPayload,
): Promise<void> => {
  const attachment = await deps.prisma.attachment.findUnique({
    where: { id: payload.attachmentId },
  })
  // Deleted since the job was enqueued, wrong tenant, or a preview already
  // landed (inline, or an earlier attempt) — nothing to do.
  if (
    !attachment
    || attachment.organizationId !== payload.organizationId
    || attachment.thumbnailKey
  ) {
    return
  }

  // The worker is the actor; the uploader is who it was done for. The usage
  // scope itself takes `uploaderId` from the row, so per-user storage totals
  // stay attributed to the person whose file this is.
  const attribution: LedgerAttribution = {
    actorId: 'worker.attachment-thumbnail',
    actorType: 'system',
    organizationId: payload.organizationId,
    systemComponent: 'worker.attachment-thumbnail',
    userId: attachment.uploaderId,
  }
  const giveUp = async (): Promise<void> => {
    await deps.fileService.setThumbnail({
      attachmentId: payload.attachmentId,
      attribution,
      organizationId: payload.organizationId,
      thumbnail: null,
    })
  }

  // Re-checked here even though the enqueuing route checks too: a job written
  // by an older build, or by hand, still gets judged before any bytes move.
  if (
    !isThumbnailableMime(attachment.mime)
    || Number(attachment.sizeBytes) > MAX_ATTACHMENT_BYTES
  ) {
    await giveUp()
    return
  }

  const opened = await deps.fileService.openStream(
    payload.attachmentId,
    payload.organizationId,
  )
  if (!opened) {
    // Bytes missing: leave the row alone so a restored object can still be
    // previewed later.
    return
  }

  const source = await readStreamCapped(opened.stream, MAX_ATTACHMENT_BYTES)
  if (!source) {
    await giveUp()
    return
  }

  // Renders never throw for bad input — a corrupt, encrypted, zero-page, or
  // absurdly-sized document comes back null and is recorded as unavailable.
  const thumbnail = await renderThumbnail(attachment.mime, source)
  await deps.fileService.setThumbnail({
    attachmentId: payload.attachmentId,
    attribution,
    organizationId: payload.organizationId,
    thumbnail,
  })
}
