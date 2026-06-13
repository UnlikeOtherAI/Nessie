import type { Readable } from 'node:stream'

import type { Attachment } from '@prisma/client'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  attributionFromActorContext,
  FileTooLargeError,
  QuotaExceededError,
  recordStorageTransferUsage,
} from '@nessie/runtime'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { toAttachmentRecord } from '../contracts.js'
import { canAccessAttachment, canAccessMessageAttachment } from '../services/attachments.js'
import type { RouteDeps } from './types.js'

// Chat/avatar uploads keep a 25 MB ceiling even though the global multipart
// limit is the (much larger) configured max — large files belong in the KB.
const MESSAGE_UPLOAD_BYTES = 25 * 1024 * 1024

const INLINE_DISPOSITION_MIMES = new Set(['application/pdf'])

const isInlineMime = (mime: string): boolean =>
  mime.startsWith('image/') || INLINE_DISPOSITION_MIMES.has(mime)

// Set download headers (inline preview for images/PDFs, attachment otherwise)
// and pipe the object stream. Shared by every attachment download route so the
// disposition/length behaviour stays identical.
export const streamAttachmentDownload = (
  reply: FastifyReply,
  opened: { stream: Readable; attachment: Attachment },
): FastifyReply => {
  const { attachment, stream } = opened
  const disposition = isInlineMime(attachment.mime) ? 'inline' : 'attachment'
  reply.header('content-type', attachment.mime)
  reply.header('content-length', attachment.sizeBytes.toString())
  reply.header(
    'content-disposition',
    `${disposition}; filename="${attachment.filename.replace(/"/g, '')}"`,
  )
  return reply.send(stream)
}

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

    try {
      const { attachment, bytesWritten } = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: file.file,
      })

      if (file.file.truncated) {
        // Past the per-route limit — undo the stored object + accounting.
        await fileService.delete(
          attachment.id,
          organizationId,
          attributionFromActorContext(actorContext),
        )
        sendApiError(
          reply,
          413,
          'FILE_TOO_LARGE',
          `File exceeds the ${MESSAGE_UPLOAD_BYTES} byte upload limit`,
        )
        return reply
      }

      void recordStorageTransferUsage(prisma, {
        attribution: attributionFromActorContext(actorContext),
        bytes: bytesWritten,
        latencyMs: Date.now() - startedAt,
        metadata: { attachmentId: attachment.id, source: 'api.uploads' },
        operation: 'upload',
      }).catch(() => undefined)

      return reply.code(201).send(createApiResponse(toAttachmentRecord(attachment)))
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

    void recordStorageTransferUsage(prisma, {
      attribution: attributionFromActorContext(actorContext),
      bytes: Number(attachment.sizeBytes),
      latencyMs: Date.now() - startedAt,
      metadata: { attachmentId: attachment.id, source: 'api.attachments' },
      operation: 'download',
    }).catch(() => undefined)
    return streamAttachmentDownload(reply, opened)
  })
}
