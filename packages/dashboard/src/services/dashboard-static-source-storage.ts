/** Durable storage and provenance for a parsed static dashboard source. */

import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Prisma } from '@prisma/client'
import { DASHBOARD_MAX_DATASET_BYTES } from '@nessie/schemas'
import type { FileService } from '@nessie/runtime'
import {
  parseStaticDataset,
  staticSourceBytesFor,
  type DashboardStaticImportFormat,
} from './dashboard-static-sources.js'
import { DashboardServiceError, type DashboardContext } from './dashboards.js'

type OriginalSourceAttachment = {
  bytes: Buffer
  filename: string
  mime: string
  reference: string
}

/**
 * A dashboard may retain an uploaded document or article as its actual source
 * material, but a bare attachment id must never be enough to get bytes into a
 * dashboard. This uses the same live message/knowledge predicates as dashboard
 * embeds, plus the upload owner's own pending attachment. The copy saved below
 * then remains available even when that conversation attachment is removed.
 */
const loadAuthorizedOriginalAttachment = async (
  context: DashboardContext,
  fileService: FileService,
  attachmentId: string,
): Promise<OriginalSourceAttachment> => {
  const attachment = await context.prisma.attachment.findFirst({
    where: { id: attachmentId, organizationId: context.actor.organizationId },
    select: {
      filename: true,
      id: true,
      knowledgePageId: true,
      messageId: true,
      mime: true,
      uploaderId: true,
    },
  })
  if (!attachment) {
    throw new DashboardServiceError(404, 'SOURCE_ATTACHMENT_NOT_FOUND', 'source attachment is not available')
  }

  const readableMessage = attachment.messageId
    ? await context.membership.canReadMessage(context.actor.userId, attachment.messageId)
    : false
  const knowledgeVersion = await context.prisma.knowledgePageVersion.findFirst({
    where: { attachmentId: attachment.id },
    select: { id: true },
  })
  const readableKnowledge = knowledgeVersion
    ? await context.membership.canReadKnowledgePageVersion(context.actor.userId, knowledgeVersion.id)
    : false
  const readableOwnUpload = attachment.uploaderId === context.actor.userId
  if (!readableMessage && !readableKnowledge && !readableOwnUpload) {
    throw new DashboardServiceError(404, 'SOURCE_ATTACHMENT_NOT_FOUND', 'source attachment is not available')
  }

  const opened = await fileService.openStream(attachment.id, context.actor.organizationId)
  if (!opened) {
    throw new DashboardServiceError(404, 'SOURCE_ATTACHMENT_BYTES_MISSING', 'source attachment bytes are not available')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of opened.stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > DASHBOARD_MAX_DATASET_BYTES) {
      opened.stream.destroy()
      throw new DashboardServiceError(422, 'SOURCE_ATTACHMENT_TOO_LARGE', 'source attachment is larger than the dashboard import limit')
    }
    chunks.push(bytes)
  }
  return {
    bytes: Buffer.concat(chunks),
    filename: attachment.filename,
    mime: attachment.mime,
    reference: `attachment:${attachment.id}`,
  }
}

export const importStaticDashboardSource = async (
  context: DashboardContext,
  input: {
    name: string
    format: DashboardStaticImportFormat
    content: string
    /** A server-authorized original file; content may be its extracted text. */
    originalAttachmentId?: string
    sourceReference?: string
    canonicalUrl?: string
    provenance?: Record<string, unknown>
    accessBasis?: { scopeId: string; scopeType: string }[]
    createdByType?: 'user' | 'agent'
  },
  fileService: FileService,
) => {
  const original = input.originalAttachmentId
    ? await loadAuthorizedOriginalAttachment(context, fileService, input.originalAttachmentId)
    : null
  // Structured attachments are parsed from the retained bytes, not from a
  // model echo. Documents and articles intentionally use their supplied
  // extraction as the normalized evidence while retaining the original file.
  const sourceBytes = original?.bytes ?? staticSourceBytesFor(input.format, input.content)
  const normalizedContent = original && (input.format === 'json' || input.format === 'csv')
    ? sourceBytes.toString('utf8')
    : original && input.format === 'xlsx'
      ? sourceBytes.toString('base64')
      : input.content
  const dataset = await parseStaticDataset({ content: normalizedContent, format: input.format })
  const bytes = Buffer.from(JSON.stringify(dataset), 'utf8')
  const digest = createHash('sha256').update(sourceBytes).digest('hex')
  const source = await context.prisma.dashboardDataSource.create({
    data: {
      organizationId: context.actor.organizationId,
      name: input.name,
      kind: 'static',
      origin: null,
      path: null,
      transform: null,
      outputColumns: dataset.columns as unknown as Prisma.InputJsonValue,
      refreshMode: 'manual',
      intervalMinutes: null,
      authorityUserId: context.actor.userId,
      createdByType: input.createdByType ?? 'user',
      createdBy: context.actor.userId,
    },
  })
  let stored: Awaited<ReturnType<FileService['store']>> | undefined
  let originalStored: Awaited<ReturnType<FileService['store']>> | undefined
  try {
    originalStored = await fileService.store({
      attribution: {
        actorId: context.actor.userId,
        actorType: input.createdByType === 'agent' ? 'agent' : 'user',
        organizationId: context.actor.organizationId,
        systemComponent: 'dashboard-static-import',
        userId: context.actor.userId,
      },
      organizationId: context.actor.organizationId,
      uploaderId: context.actor.userId,
      filename: original?.filename
        ?? `dashboard-source-${source.id}-${randomUUID()}.${input.format === 'xlsx' ? 'xlsx' : 'txt'}`,
      mime: original?.mime
        ?? (input.format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/plain'),
      body: Readable.from(sourceBytes),
    })
    stored = await fileService.store({
      attribution: {
        actorId: context.actor.userId,
        actorType: input.createdByType === 'agent' ? 'agent' : 'user',
        organizationId: context.actor.organizationId,
        systemComponent: 'dashboard-static-import',
        userId: context.actor.userId,
      },
      organizationId: context.actor.organizationId,
      uploaderId: context.actor.userId,
      filename: `dashboard-static-${source.id}-${randomUUID()}.json`,
      mime: 'application/json',
      body: Readable.from(bytes),
    })
    const storedFile = stored
    const originalFile = originalStored
    if (!originalFile) {
      throw new DashboardServiceError(500, 'DASHBOARD_SOURCE_ORIGINAL_MISSING', 'original source bytes were not retained')
    }
    if (!('$transaction' in context.prisma)) {
      throw new DashboardServiceError(500, 'DASHBOARD_TRANSACTION_REQUIRED', 'source import needs a root database client')
    }
    await context.prisma.$transaction(async (tx) => {
      const row = await tx.dashboardDataset.create({
        data: {
          organizationId: context.actor.organizationId,
          sourceId: source.id,
          attachmentId: storedFile.attachment.id,
          schemaVersion: dataset.schemaVersion,
          rowCount: dataset.rows.length,
          byteSize: bytes.byteLength,
          fetchedAt: new Date(dataset.fetchedAt),
        },
      })
      await tx.dashboardSourceMaterial.create({
        data: {
          organizationId: context.actor.organizationId,
          sourceId: source.id,
          kind: input.format,
          sourceReference: input.sourceReference ?? original?.reference ?? null,
          canonicalUrl: input.canonicalUrl ?? null,
          contentDigest: digest,
          originalAttachmentId: originalFile.attachment.id,
          parser: `dashboard-${input.format}-v1`,
          provenance: {
            ...(input.provenance ?? {}),
            ...(original ? { originalAttachmentSource: original.reference } : {}),
          } as Prisma.InputJsonValue,
          accessBasis: (input.accessBasis?.length
            ? input.accessBasis
            : [{ scopeId: context.actor.userId, scopeType: 'user' }]) as unknown as Prisma.InputJsonValue,
          normalizationLosses: (input.format === 'document' || input.format === 'article'
            ? [{
              kind: 'line_table',
              detail: original
                ? 'Each non-empty extracted line was retained as one table row; the original attachment is retained separately.'
                : 'Each non-empty supplied source line was retained as one table row.',
            }]
            : []) as Prisma.InputJsonValue,
        },
      })
      await tx.dashboardDataSource.update({
        where: { id: source.id },
        data: { latestDatasetId: row.id, lastAttemptAt: new Date(), lastValidatedAt: new Date() },
      })
    })
  } catch (error) {
    if (stored) {
      await fileService.delete(stored.attachment.id, context.actor.organizationId, {
        actorId: context.actor.userId,
        actorType: 'user',
        organizationId: context.actor.organizationId,
        systemComponent: 'dashboard-static-import',
      }).catch(() => undefined)
    }
    if (originalStored) {
      await fileService.delete(originalStored.attachment.id, context.actor.organizationId, {
        actorId: context.actor.userId,
        actorType: 'user',
        organizationId: context.actor.organizationId,
        systemComponent: 'dashboard-static-import',
      }).catch(() => undefined)
    }
    await context.prisma.dashboardDataSource.delete({ where: { id: source.id } }).catch(() => undefined)
    throw error
  }
  return source
}
