import { Readable } from 'node:stream'

import type { Attachment } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ATTACHMENT_THUMBNAIL_TOPIC, detectSecrets, MESSAGE_UPLOAD_MAX_BYTES } from '@nessie/schemas'
import {
  attributionFromActorContext,
  FileTooLargeError,
  isThumbnailableMime,
  type LedgerAttribution,
  QuotaExceededError,
  recordStorageTransferUsage,
} from '@nessie/runtime'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { readStreamCapped } from '../lib/markdown.js'
import { toAttachmentRecord } from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { canAccessAttachment, canAccessMessageAttachment } from '../services/attachments.js'
import type { RouteDeps } from './types.js'
import { uploadContainsDetectedSecret } from './upload-secret-scan.js'

// Chat/avatar uploads keep a 25 MB ceiling even though the global multipart
// limit is the (much larger) configured max — large files belong in the KB.
// Shared with the admin composer's pre-flight check via @nessie/schemas.
const MESSAGE_UPLOAD_BYTES = MESSAGE_UPLOAD_MAX_BYTES

const INLINE_DISPOSITION_MIMES = new Set(['application/pdf'])

// image/svg+xml is an active-content type (it can carry <script>), so it must
// never be served inline — only raster images and PDFs preview in-browser.
const isInlineMime = (mime: string): boolean =>
  (mime.startsWith('image/') && mime !== 'image/svg+xml') || INLINE_DISPOSITION_MIMES.has(mime)

// Attachment bytes are immutable: an id is minted per stored object and its
// content never changes (an "edit" is a fresh upload with a fresh id). So the
// browser HTTP cache may keep them forever, which is what stops a chat feed
// re-transferring every image on each render. `private` because the bytes are
// tenant-scoped and must never land in a shared proxy cache — verified to still
// be stored by the browser even though these requests carry a bearer token, and
// `immutable` keeps a manual reload from revalidating them.
export const ATTACHMENT_CACHE_CONTROL = 'private, max-age=31536000, immutable'

// Strong validator over the only two facts that identify the exact bytes: the
// attachment id and its stored size. Both are fixed at store time.
const attachmentETag = (attachment: { id: string; sizeBytes: bigint }): string =>
  `"${attachment.id}-${attachment.sizeBytes.toString()}"`

// RFC 9110: a client may send a list, and `*` matches any current
// representation. Weak comparison is the required function for If-None-Match.
const matchesETag = (header: string | undefined, etag: string): boolean => {
  if (!header) return false
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag)
}

// Who is downloading and where from, so the shared helper can write the
// transfer-usage event itself — and skip it on a 304, where no bytes move.
export type AttachmentTransferUsage = {
  prisma: RouteDeps['prisma']
  attribution: LedgerAttribution
  startedAt: number
  // Route identifier recorded on the usage event (e.g. `api.attachments`).
  source: string
}

// Set download headers (inline preview for images/PDFs, attachment otherwise)
// and pipe the object stream. Shared by every attachment download route so the
// disposition/length/caching/accounting behaviour stays identical. Returns a
// 304 without transferring (or metering) when the client already holds these
// exact bytes.
export const streamAttachmentDownload = (
  request: FastifyRequest,
  reply: FastifyReply,
  opened: { stream: Readable; attachment: Attachment },
  usage: AttachmentTransferUsage,
): FastifyReply => {
  const { attachment, stream } = opened
  const etag = attachmentETag(attachment)
  reply.header('cache-control', ATTACHMENT_CACHE_CONTROL)
  reply.header('etag', etag)
  reply.header('last-modified', attachment.createdAt.toUTCString())
  if (matchesETag(request.headers['if-none-match'], etag)) {
    stream.destroy()
    return reply.code(304).send()
  }
  void recordStorageTransferUsage(usage.prisma, {
    attribution: usage.attribution,
    bytes: Number(attachment.sizeBytes),
    latencyMs: Date.now() - usage.startedAt,
    metadata: { attachmentId: attachment.id, source: usage.source },
    operation: 'download',
  }).catch(() => undefined)
  const disposition = isInlineMime(attachment.mime) ? 'inline' : 'attachment'
  reply.header('content-type', attachment.mime)
  reply.header('content-length', attachment.sizeBytes.toString())
  // Never let the browser sniff a download into active content.
  reply.header('x-content-type-options', 'nosniff')
  // Defence in depth for anything served inline (today: PDFs). A sandboxed,
  // origin-less document cannot run scripts, load subresources or reach the
  // admin origin even if a file's declared type is wrong or a viewer is
  // exploitable — the bytes here are user-uploaded.
  reply.header('content-security-policy', "default-src 'none'; sandbox")
  reply.header(
    'content-disposition',
    `${disposition}; filename="${attachment.filename.replace(/"/g, '')}"`,
  )
  return reply.send(stream)
}

// Ask the worker for a preview of what the store chokepoint could not produce
// inline: PDFs, animated/exotic images, oversized images, and orgs opted out of
// metadata stripping. Fire-and-forget, mirroring enqueueKnowledgeExtract — the
// upload is already committed, so a queue-insert failure must not fail the
// request; it only means this file has no preview until something re-enqueues.
// Returns the attachment as the caller should serialize it, so the upload
// response reports `pending` rather than claiming there is no preview coming.
const enqueueAttachmentThumbnail = async (
  prisma: RouteDeps['prisma'],
  attachment: Attachment,
): Promise<Attachment> => {
  if (attachment.thumbnailKey || !isThumbnailableMime(attachment.mime)) {
    return attachment
  }
  try {
    const pending = await prisma.attachment.update({
      where: { id: attachment.id },
      data: { thumbnailStatus: 'pending' },
    })
    await enqueueQueueJob(prisma, {
      idempotencyKey: `thumb:${attachment.id}`,
      payload: {
        attachmentId: attachment.id,
        organizationId: attachment.organizationId,
      },
      topic: ATTACHMENT_THUMBNAIL_TOPIC,
    })
    return pending
  } catch (error) {
    console.error('[uploads] Failed to enqueue attachment.thumbnail:', attachment.id, error)
    return attachment
  }
}

// A row this service does not model still points at the attachment; deleting
// the bytes would orphan it, so the caller gets a 409 instead.
const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'P2003'

// Map FileService errors to HTTP. Returns true when it handled the error.
export const sendFileServiceError = (reply: FastifyReply, error: unknown): boolean => {
  if (error instanceof QuotaExceededError) {
    sendApiError(reply, 507, 'STORAGE_QUOTA_EXCEEDED', error.message)
    return true
  }
  if (error instanceof FileTooLargeError) {
    sendApiError(reply, 413, 'FILE_TOO_LARGE', error.message)
    return true
  }
  return false
}

export const registerUploadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, fileService } = deps

  app.post('/api/uploads', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const file = await request.file({ limits: { fileSize: MESSAGE_UPLOAD_BYTES } })
    if (!file) {
      sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
      return reply
    }

    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'
    const organizationId = actorContext.tenant.organizationId

    // Filenames are durable attachment metadata and later enter model-visible
    // attachment descriptions, so they share the same pre-storage boundary as
    // file bytes.
    if (detectSecrets(filename).length > 0) {
      // The multipart parser already handed us a live stream. Drain it even on
      // metadata rejection so the connection does not retain unread request
      // bytes while the client receives the refusal.
      file.file.resume()
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'A possible credential was intercepted in this filename. Rename the file and save the value through Secrets instead.',
      )
      return reply
    }

    // Inspect the bytes before object storage without trusting the caller's
    // MIME type. UTF-8/ASCII and UTF-16 text are decoded explicitly; binary
    // formats still get their raw byte stream checked for embedded ASCII.
    const upload = await readStreamCapped(file.file, MESSAGE_UPLOAD_BYTES)
    if (!upload || file.file.truncated) {
      sendApiError(reply, 413, 'FILE_TOO_LARGE', `File exceeds the ${MESSAGE_UPLOAD_BYTES} byte upload limit`)
      return reply
    }
    if (uploadContainsDetectedSecret(upload)) {
      sendApiError(
        reply,
        422,
        'SECRET_INTERCEPTED',
        'A possible credential was intercepted before this file was stored. Save it through Secrets instead.',
      )
      return reply
    }

    try {
      const { attachment, bytesWritten } = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: Readable.from(upload),
      })

      void recordStorageTransferUsage(prisma, {
        attribution: attributionFromActorContext(actorContext),
        bytes: bytesWritten,
        latencyMs: Date.now() - startedAt,
        metadata: { attachmentId: attachment.id, source: 'api.uploads' },
        operation: 'upload',
      }).catch(() => undefined)

      const stored = await enqueueAttachmentThumbnail(prisma, attachment)

      return reply.code(201).send(createApiResponse(toAttachmentRecord(stored)))
    } catch (error) {
      if (sendFileServiceError(reply, error)) {
        return reply
      }
      throw error
    }
  })

  app.get('/api/messages/:messageId/attachments', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { messageId } = request.params as { messageId: string }
    const canAccess = await canAccessMessageAttachment(prisma, {
      messageId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    })
    if (!canAccess) {
      sendApiError(reply, 404, 'MESSAGE_NOT_FOUND', 'Message not found')
      return reply
    }

    const attachments = await prisma.attachment.findMany({
      where: { messageId, organizationId: actorContext.tenant.organizationId },
      orderBy: { createdAt: 'asc' },
    })

    return createApiResponse(attachments.map(toAttachmentRecord))
  })

  app.get('/api/attachments/:id', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { id } = request.params as { id: string }
    const attachment = await prisma.attachment.findUnique({ where: { id } })
    if (
      !attachment ||
      !(await canAccessAttachment(prisma, attachment, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      }))
    ) {
      sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
      return reply
    }

    const opened = await fileService.openStream(id, actorContext.tenant.organizationId)
    if (!opened) {
      sendApiError(reply, 404, 'ATTACHMENT_BYTES_MISSING', 'Attachment bytes not found')
      return reply
    }

    return streamAttachmentDownload(request, reply, opened, {
      attribution: attributionFromActorContext(actorContext),
      prisma,
      source: 'api.attachments',
      startedAt,
    })
  })

  // Cheap inline preview of an attachment: a small WebP derivative generated at
  // the FileService chokepoint (images) or by the `attachment.thumbnail` worker
  // job (PDF first page, oversized/animated images). Same ACL as the original —
  // deliberately reusing canAccessAttachment, which denies KB blobs here — and
  // the same immutable caching. 404 when there is no thumbnail so the client
  // falls back to the original (or a download chip).
  app.get('/api/attachments/:id/thumbnail', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { id } = request.params as { id: string }
    const attachment = await prisma.attachment.findUnique({ where: { id } })
    if (
      !attachment ||
      !(await canAccessAttachment(prisma, attachment, {
        organizationId: actorContext.tenant.organizationId,
        userId: actorContext.actor.actorId,
      }))
    ) {
      sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
      return reply
    }

    const opened = await fileService.openThumbnailStream(
      id,
      actorContext.tenant.organizationId,
    )
    if (!opened) {
      sendApiError(reply, 404, 'THUMBNAIL_NOT_FOUND', 'Attachment has no thumbnail')
      return reply
    }

    return streamAttachmentDownload(request, reply, opened, {
      attribution: attributionFromActorContext(actorContext),
      prisma,
      source: 'api.attachments.thumbnail',
      startedAt,
    })
  })

  // Discard a staged-then-removed composer upload. Deliberately narrow: only
  // the uploader's own attachment, and only while nothing references it yet.
  // Anything already attached to a message, KB page, logo, avatar, or feedback
  // item is not deletable here (its owning surface deletes it).
  app.delete('/api/attachments/:id', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const { id } = request.params as { id: string }
    const organizationId = actorContext.tenant.organizationId
    const deletable = await prisma.attachment.findFirst({
      where: {
        id,
        organizationId,
        uploaderId: actorContext.actor.actorId,
        messageId: null,
        knowledgePageId: null,
        logoForOrganizations: { none: {} },
        avatarForUsers: { none: {} },
        avatarForAgents: { none: {} },
        feedbackItems: { none: {} },
      },
      select: { id: true },
    })
    if (!deletable) {
      sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
      return reply
    }

    try {
      // The FileService is the chokepoint: it removes the row, the object, and
      // writes the -bytes StorageUsageEvent in one place.
      const deleted = await fileService.delete(
        id,
        organizationId,
        attributionFromActorContext(actorContext),
      )
      if (!deleted) {
        sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
        return reply
      }
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        sendApiError(reply, 409, 'ATTACHMENT_IN_USE', 'Attachment is still referenced')
        return reply
      }
      throw error
    }

    return reply.code(204).send()
  })
}
