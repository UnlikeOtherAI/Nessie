import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { attributionFromActorContext, recordStorageTransferUsage } from '@nessie/runtime'
import type { FileService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { z } from 'zod'

import { toAttachmentRecord } from '../contracts.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import {
  actorAuthorType,
  attachPageEnvelope,
  createKnowledgeAccess,
  requireKnowledgePolicy,
  requestIds,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import { sendKnowledgeMutationError } from './knowledge-base-errors.js'
import { sendFileServiceError, streamAttachmentDownload } from './uploads.js'

const CreateFileNodeQuerySchema = z.object({
  parentPageId: z.string().uuid().optional(),
  title: z.string().min(1).max(512).optional(),
})

const StorageUsageQuerySchema = z.object({
  scopeType: z.enum(['organization', 'project', 'team', 'space', 'uploader']).default('organization'),
  scopeId: z.string().uuid().optional(),
})

const usageScopeId = (
  actorContext: AuthorizedActionContext,
  scopeType: string,
  scopeId: string | undefined,
): string | null => {
  if (scopeType === 'organization') return actorContext.tenant.organizationId
  return scopeId ?? null
}

const readUsage = async (
  fileService: FileService,
  organizationId: string,
  scopeType: string,
  scopeId: string,
): Promise<{ usedBytes: string; limitBytes: string | null }> => {
  if (scopeType === 'project') {
    const u = await fileService.currentUsage({ organizationId, projectId: scopeId })
    return { usedBytes: u.usedBytes.toString(), limitBytes: u.limitBytes?.toString() ?? null }
  }
  if (scopeType === 'team') {
    const u = await fileService.currentUsage({ organizationId, teamId: scopeId })
    return { usedBytes: u.usedBytes.toString(), limitBytes: u.limitBytes?.toString() ?? null }
  }
  if (scopeType === 'space') {
    const used = await fileService.usageForScope({ organizationId, spaceId: scopeId })
    return { usedBytes: used.toString(), limitBytes: null }
  }
  if (scopeType === 'uploader') {
    const used = await fileService.usageForScope({ organizationId, uploaderId: scopeId })
    return { usedBytes: used.toString(), limitBytes: null }
  }
  const u = await fileService.currentUsage({ organizationId })
  return { usedBytes: u.usedBytes.toString(), limitBytes: u.limitBytes?.toString() ?? null }
}

export const registerKnowledgeBaseFileRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext, fileService } = deps
  const { provider, buildViewer, accessSpace, accessPageSpace } = createKnowledgeAccess(deps)

  const requireFilePart = async (request: FastifyRequest, reply: FastifyReply) => {
    const file = await request.file()
    if (!file) {
      sendApiError(reply, 400, 'NO_FILE', 'No file part found in the upload')
      return null
    }
    return file
  }

  // ─── Create a file node in a space ────────────────────────────────────────
  app.post('/api/knowledge-base/spaces/:spaceId/files', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(CreateFileNodeQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'create')
    if (!decision) return reply
    const { spaceId } = request.params as { spaceId: string }
    const viewer = await buildViewer(actorContext)
    const space = await accessSpace(actorContext, spaceId, viewer, 'write', reply)
    if (!space) return reply

    const file = await requireFilePart(request, reply)
    if (!file) return reply
    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'

    let attachmentId: string
    try {
      const stored = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId: actorContext.tenant.organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: file.file,
        scope: { projectId: space.projectId, teamId: space.teamId, spaceId: space.id },
      })
      attachmentId = stored.attachment.id
      if (file.file.truncated) {
        await fileService.delete(
          attachmentId,
          actorContext.tenant.organizationId,
          attributionFromActorContext(actorContext),
        )
        sendApiError(reply, 413, 'FILE_TOO_LARGE', 'File exceeds the upload limit')
        return reply
      }
    } catch (error) {
      if (sendFileServiceError(reply, error)) return reply
      throw error
    }

    try {
      const page = await provider.createPage({
        organizationId: actorContext.tenant.organizationId,
        projectId: space.projectId,
        spaceId,
        kind: 'file',
        title: query.title ?? filename,
        parentPageId: query.parentPageId ?? null,
        attachmentId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
        createdBy: actorContext.actor.actorId,
      })
      await emitAuditEvent(prisma, {
        actorContext,
        action: 'kb.page.created',
        resourceType: 'knowledge_page',
        resourceId: page.id,
        outcome: 'success',
        metadata: { spaceId, title: page.title, kind: 'file' },
        ...requestIds(request),
      })
      return reply.code(201).send(createApiResponse(attachPageEnvelope(page, decision)))
    } catch (error) {
      // Roll back the orphaned object if the page row could not be created.
      await fileService
        .delete(attachmentId, actorContext.tenant.organizationId, attributionFromActorContext(actorContext))
        .catch(() => undefined)
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'File node could not be created',
        statusCode: 400,
      })
    }
  })

  // ─── Upload a new version of a file node ──────────────────────────────────
  app.post('/api/knowledge-base/pages/:pageId/file-version', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    if (page.kind !== 'file') {
      return sendApiError(reply, 400, 'NOT_A_FILE_NODE', 'Page is not a file node')
    }
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'write', reply))) return reply

    const file = await requireFilePart(request, reply)
    if (!file) return reply
    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'

    let attachmentId: string
    try {
      const stored = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId: actorContext.tenant.organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: file.file,
        scope: { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId },
      })
      attachmentId = stored.attachment.id
      if (file.file.truncated) {
        await fileService.delete(
          attachmentId,
          actorContext.tenant.organizationId,
          attributionFromActorContext(actorContext),
        )
        sendApiError(reply, 413, 'FILE_TOO_LARGE', 'File exceeds the upload limit')
        return reply
      }
    } catch (error) {
      if (sendFileServiceError(reply, error)) return reply
      throw error
    }

    try {
      const version = await provider.addFileVersion({
        organizationId: actorContext.tenant.organizationId,
        pageId,
        attachmentId,
        authorId: actorContext.actor.actorId,
        authorType: actorAuthorType(actorContext),
      })
      if (!version) {
        await fileService
          .delete(attachmentId, actorContext.tenant.organizationId, attributionFromActorContext(actorContext))
          .catch(() => undefined)
        return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      }
      return reply.code(201).send(createApiResponse(version))
    } catch (error) {
      await fileService
        .delete(attachmentId, actorContext.tenant.organizationId, attributionFromActorContext(actorContext))
        .catch(() => undefined)
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_PAGE_INVALID',
        message: 'File version could not be added',
        statusCode: 400,
      })
    }
  })

  // ─── Download a specific version's file ───────────────────────────────────
  app.get('/api/knowledge-base/pages/:pageId/versions/:versionId/download', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId, versionId } = request.params as { pageId: string; versionId: string }
    const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply

    const version = await prisma.knowledgePageVersion.findFirst({
      where: { id: versionId, pageId },
      select: { attachmentId: true },
    })
    if (!version?.attachmentId) {
      return sendApiError(reply, 404, 'VERSION_FILE_NOT_FOUND', 'Version has no file')
    }
    const opened = await fileService.openStream(version.attachmentId, actorContext.tenant.organizationId)
    if (!opened) return sendApiError(reply, 404, 'ATTACHMENT_BYTES_MISSING', 'File bytes not found')
    void recordStorageTransferUsage(prisma, {
      attribution: attributionFromActorContext(actorContext),
      bytes: Number(opened.attachment.sizeBytes),
      latencyMs: Date.now() - startedAt,
      metadata: { attachmentId: opened.attachment.id, source: 'api.kb.fileVersion' },
      operation: 'download',
    }).catch(() => undefined)
    return streamAttachmentDownload(reply, opened)
  })

  // ─── List a page's drawer attachments ─────────────────────────────────────
  app.get('/api/knowledge-base/pages/:pageId/attachments', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply
    const attachments = await prisma.attachment.findMany({
      where: { knowledgePageId: pageId, organizationId: actorContext.tenant.organizationId },
      orderBy: { createdAt: 'asc' },
    })
    return createApiResponse(attachments.map(toAttachmentRecord))
  })

  // ─── Upload a drawer attachment to a page ─────────────────────────────────
  app.post('/api/knowledge-base/pages/:pageId/attachments', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { pageId } = request.params as { pageId: string }
    const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
    if (!page) return sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'write', reply))) return reply

    const file = await requireFilePart(request, reply)
    if (!file) return reply
    const mime = file.mimetype || 'application/octet-stream'
    const filename = file.filename || 'upload.bin'

    try {
      const { attachment, bytesWritten } = await fileService.store({
        attribution: attributionFromActorContext(actorContext),
        organizationId: actorContext.tenant.organizationId,
        uploaderId: actorContext.actor.actorId,
        filename,
        mime,
        body: file.file,
        knowledgePageId: pageId,
        scope: { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId },
      })
      if (file.file.truncated) {
        await fileService.delete(
          attachment.id,
          actorContext.tenant.organizationId,
          attributionFromActorContext(actorContext),
        )
        sendApiError(reply, 413, 'FILE_TOO_LARGE', 'File exceeds the upload limit')
        return reply
      }
      void recordStorageTransferUsage(prisma, {
        attribution: attributionFromActorContext(actorContext),
        bytes: bytesWritten,
        latencyMs: Date.now() - startedAt,
        metadata: { attachmentId: attachment.id, source: 'api.kb.attachment' },
        operation: 'upload',
      }).catch(() => undefined)
      return reply.code(201).send(createApiResponse(toAttachmentRecord(attachment)))
    } catch (error) {
      if (sendFileServiceError(reply, error)) return reply
      throw error
    }
  })

  // ─── Download a page attachment ───────────────────────────────────────────
  app.get('/api/knowledge-base/attachments/:attachmentId/download', async (request, reply) => {
    const startedAt = Date.now()
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'read')
    if (!decision) return reply
    const { attachmentId } = request.params as { attachmentId: string }
    const row = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!row?.knowledgePageId || row.organizationId !== actorContext.tenant.organizationId) {
      return sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    }
    const page = await provider.getPage(actorContext.tenant.organizationId, row.knowledgePageId)
    if (!page) return sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'read', reply))) return reply
    const opened = await fileService.openStream(attachmentId, actorContext.tenant.organizationId)
    if (!opened) return sendApiError(reply, 404, 'ATTACHMENT_BYTES_MISSING', 'Attachment bytes not found')
    void recordStorageTransferUsage(prisma, {
      attribution: attributionFromActorContext(actorContext),
      bytes: Number(opened.attachment.sizeBytes),
      latencyMs: Date.now() - startedAt,
      metadata: { attachmentId, source: 'api.kb.attachment' },
      operation: 'download',
    }).catch(() => undefined)
    return streamAttachmentDownload(reply, opened)
  })

  // ─── Delete a page attachment ─────────────────────────────────────────────
  app.delete('/api/knowledge-base/attachments/:attachmentId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_page', 'edit')
    if (!decision) return reply
    const { attachmentId } = request.params as { attachmentId: string }
    const row = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    if (!row?.knowledgePageId || row.organizationId !== actorContext.tenant.organizationId) {
      return sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    }
    const page = await provider.getPage(actorContext.tenant.organizationId, row.knowledgePageId)
    if (!page) return sendApiError(reply, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    const viewer = await buildViewer(actorContext)
    if (!(await accessPageSpace(actorContext, page, viewer, 'write', reply))) return reply
    await fileService.delete(
      attachmentId,
      actorContext.tenant.organizationId,
      attributionFromActorContext(actorContext),
      { projectId: page.projectId, teamId: page.teamId, spaceId: page.spaceId },
    )
    return reply.code(204).send()
  })

  // ─── Storage usage (reporting) ────────────────────────────────────────────
  app.get('/api/knowledge-base/storage-usage', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const query = parseInput(StorageUsageQuerySchema, request.query, reply, 'query')
    if (!query) return reply
    const decision = await requireKnowledgePolicy(deps, actorContext, reply, 'knowledge_space', 'view')
    if (!decision) return reply
    const scopeType = query.scopeType ?? 'organization'
    const scopeId = usageScopeId(actorContext, scopeType, query.scopeId)
    if (!scopeId) {
      return sendApiError(reply, 400, 'SCOPE_ID_REQUIRED', 'scopeId is required for this scope')
    }
    const usage = await readUsage(fileService, actorContext.tenant.organizationId, scopeType, scopeId)
    return createApiResponse(usage)
  })
}
