import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { getStorage, type StorageConfig } from '@nessie/runtime'

import { AttachmentRecordSchema } from '../contracts.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { canAccessAttachment, canAccessMessageAttachment } from '../services/attachments.js'
import type { RouteDeps } from './types.js'

// 25 MB upload ceiling. Mirrored in the multipart plugin registration in
// api/src/index.ts so oversize streams are rejected before buffering.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

// Derive a coarse attachment `kind` from the MIME type for cheap UI branching
// (inline image preview vs. download chip) without re-parsing MIME everywhere.
const kindFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

const buildStorageConfig = (deps: RouteDeps): StorageConfig => ({
  provider: deps.config.storage.provider,
  bucket: deps.config.storage.bucket,
  localPath: deps.config.storage.localPath,
})

const INLINE_DISPOSITION_MIMES = new Set(['application/pdf'])

const isInlineMime = (mime: string): boolean =>
  mime.startsWith('image/') || INLINE_DISPOSITION_MIMES.has(mime)

export const registerUploadRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext } = deps

  app.post('/api/uploads', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) {
      return reply
    }

    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } })
    if (!file) {
      sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
      return reply
    }

    const bytes = await file.toBuffer()
    if (file.file.truncated) {
      sendApiError(
        reply,
        413,
        'FILE_TOO_LARGE',
        `File exceeds the ${MAX_UPLOAD_BYTES} byte upload limit`,
      )
      return reply
    }

    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'
    const organizationId = actorContext.tenant.organizationId
    const storageKey = `${organizationId}/${randomUUID()}`

    const storage = getStorage(buildStorageConfig(deps))
    await storage.put(storageKey, bytes, mime)

    const attachment = await prisma.attachment.create({
      data: {
        organizationId,
        uploaderId: actorContext.actor.actorId,
        kind: kindFromMime(mime),
        mime,
        filename,
        sizeBytes: bytes.byteLength,
        storageKey,
      },
    })

    return reply.code(201).send(
      createApiResponse(
        AttachmentRecordSchema.parse({
          id: attachment.id,
          organizationId: attachment.organizationId,
          uploaderId: attachment.uploaderId ?? undefined,
          messageId: attachment.messageId ?? undefined,
          kind: attachment.kind,
          mime: attachment.mime,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
          width: attachment.width ?? undefined,
          height: attachment.height ?? undefined,
          createdAt: attachment.createdAt.toISOString(),
        }),
      ),
    )
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

    return createApiResponse(
      attachments.map((attachment) =>
        AttachmentRecordSchema.parse({
          id: attachment.id,
          organizationId: attachment.organizationId,
          uploaderId: attachment.uploaderId ?? undefined,
          messageId: attachment.messageId ?? undefined,
          kind: attachment.kind,
          mime: attachment.mime,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
          width: attachment.width ?? undefined,
          height: attachment.height ?? undefined,
          createdAt: attachment.createdAt.toISOString(),
        }),
      ),
    )
  })

  app.get('/api/attachments/:id', async (request, reply) => {
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

    const storage = getStorage(buildStorageConfig(deps))
    const bytes = await storage.get(attachment.storageKey)
    if (!bytes) {
      sendApiError(reply, 404, 'ATTACHMENT_BYTES_MISSING', 'Attachment bytes not found')
      return reply
    }

    const disposition = isInlineMime(attachment.mime) ? 'inline' : 'attachment'
    reply.header('content-type', attachment.mime)
    reply.header(
      'content-disposition',
      `${disposition}; filename="${attachment.filename.replace(/"/g, '')}"`,
    )
    return reply.send(bytes)
  })
}
