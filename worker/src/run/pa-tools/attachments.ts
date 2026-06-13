import { Readable } from 'node:stream'

import { loadConfig } from '@nessie/config'
import {
  attributionFromActorContext,
  collectStream,
  createFileService,
  getStorage,
  type FileService,
} from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  isDelegatingPersonalAssistant,
} from './access.js'
import { clampLimit, formatSection, truncate } from './tool-output.js'

const ATTACHMENT_READ_MAX_TEXT_BYTES = 64 * 1024

const isTextLikeMime = (mime: string): boolean =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime.endsWith('+json') ||
  mime.endsWith('+xml')

// All blob work goes through the single FileService (storage + Attachment row +
// stored-bytes accounting), same as the API. Built from config per call.
const fileServiceFor = (prisma: PrismaClient): FileService => {
  const config = loadConfig()
  return createFileService({
    prisma,
    storage: getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
  })
}

export const runAttachmentUploadTool = async (
  context: BuiltinToolRuntimeContext,
  input: { filename?: string; mime?: string; contentBase64?: string },
): Promise<ToolExecutionResult> => {
  const filename = (input.filename ?? '').trim()
  const mime = (input.mime ?? '').trim() || 'application/octet-stream'
  if (!filename) {
    throw new Error('filename is required.')
  }
  if (!input.contentBase64) {
    throw new Error('contentBase64 is required.')
  }

  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (bytes.byteLength === 0) {
    throw new Error('contentBase64 decoded to zero bytes.')
  }

  const organizationId = context.channel.organizationId
  const uploaderId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  const { attachment } = await fileServiceFor(context.prisma).store({
    attribution: attributionFromActorContext(context.actorContext),
    organizationId,
    uploaderId,
    filename,
    mime,
    body: Readable.from(bytes),
  })

  return {
    connectorUsage: {
      connectorType: 'storage',
      target: 'attachment',
      operation: 'upload',
      calls: 1,
      units: Number(attachment.sizeBytes),
      unitType: 'bytes',
      metadata: { attachmentId: attachment.id, source: 'worker.attachment_upload' },
    },
    inputSummary: `filename=${filename}`,
    outputPreview: [
      `Uploaded attachment id=${attachment.id}`,
      `filename=${attachment.filename} | mime=${attachment.mime} | sizeBytes=${attachment.sizeBytes}`,
      'Link it to a message via send_message attachmentIds.',
    ].join('\n'),
    toolName: 'attachment_upload',
  }
}

export const runAttachmentListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { threadId?: string; channelId?: string; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  const organizationId = context.channel.organizationId
  const take = clampLimit(input.limit, 20)

  // Resolve the candidate message ids in a thread/channel the caller can see,
  // then list attachments linked to those messages. Without a user context fall
  // back to the run's own thread.
  const threadId = input.threadId ?? (input.channelId ? undefined : context.run.threadId)
  const visibleChannel = userId
    ? buildVisibleChannelWhere(
        organizationId,
        userId,
        isDelegatingPersonalAssistant(context),
      )
    : { organizationId }

  const messageWhere = input.channelId
    ? { thread: { channelId: input.channelId, channel: visibleChannel } }
    : { thread: { id: threadId, channel: visibleChannel } }

  const messages = await context.prisma.message.findMany({
    where: messageWhere,
    select: { id: true },
    take: 200,
  })
  const messageIds = messages.map((m) => m.id)

  if (messageIds.length === 0) {
    return {
      inputSummary: input.channelId
        ? `channelId=${input.channelId}`
        : `threadId=${threadId}`,
      outputPreview: 'No accessible messages found for the requested scope.',
      toolName: 'attachment_list',
    }
  }

  const attachments = await context.prisma.attachment.findMany({
    where: { organizationId, messageId: { in: messageIds } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filename: true, mime: true, sizeBytes: true },
    take,
  })

  const lines = attachments.map(
    (a, index) =>
      `${index + 1}. id=${a.id} | ${a.filename} | mime=${a.mime} | sizeBytes=${a.sizeBytes}`,
  )

  return {
    inputSummary: input.channelId
      ? `channelId=${input.channelId}`
      : `threadId=${threadId}`,
    outputPreview:
      formatSection(`Attachments (${lines.length})`, lines) || 'No attachments found.',
    toolName: 'attachment_list',
  }
}

export const runAttachmentReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: { id?: string },
): Promise<ToolExecutionResult> => {
  const id = (input.id ?? '').trim()
  if (!id) {
    throw new Error('id is required.')
  }

  const attachment = await context.prisma.attachment.findUnique({ where: { id } })
  if (!attachment || attachment.organizationId !== context.channel.organizationId) {
    throw new Error('Attachment not found.')
  }

  // Authorize like attachment_list: only message-linked blobs the caller can see
  // via their visible channels are readable. KB / avatar / unlinked blobs are not
  // served through this message-oriented tool (KB reads need space-access checks).
  const readerId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null
  if (!attachment.messageId) {
    throw new Error('Attachment not found.')
  }
  const visibleChannel = readerId
    ? buildVisibleChannelWhere(
        attachment.organizationId,
        readerId,
        isDelegatingPersonalAssistant(context),
      )
    : { organizationId: attachment.organizationId }
  const visibleMessage = await context.prisma.message.findFirst({
    where: { id: attachment.messageId, thread: { channel: visibleChannel } },
    select: { id: true },
  })
  if (!visibleMessage) {
    throw new Error('Attachment not found.')
  }

  const metadataLines = [
    `id=${attachment.id}`,
    `filename=${attachment.filename}`,
    `mime=${attachment.mime}`,
    `kind=${attachment.kind}`,
    `sizeBytes=${attachment.sizeBytes}`,
  ]

  if (
    !isTextLikeMime(attachment.mime) ||
    Number(attachment.sizeBytes) > ATTACHMENT_READ_MAX_TEXT_BYTES
  ) {
    return {
      inputSummary: `id=${id}`,
      outputPreview: [
        ...metadataLines,
        'content=(binary or too large to inline; metadata only)',
      ].join('\n'),
      toolName: 'attachment_read',
    }
  }

  const opened = await fileServiceFor(context.prisma).openStream(
    attachment.id,
    context.channel.organizationId,
  )
  if (!opened) {
    return {
      inputSummary: `id=${id}`,
      outputPreview: [...metadataLines, 'content=(stored bytes missing)'].join('\n'),
      toolName: 'attachment_read',
    }
  }
  const bytes = await collectStream(opened.stream)

  return {
    connectorUsage: {
      connectorType: 'storage',
      target: 'attachment',
      operation: 'download',
      calls: 1,
      units: bytes.byteLength,
      unitType: 'bytes',
      metadata: { attachmentId: attachment.id, source: 'worker.attachment_read' },
    },
    inputSummary: `id=${id}`,
    outputPreview: [
      ...metadataLines,
      'content:',
      truncate(bytes.toString('utf8'), 8000),
    ].join('\n'),
    toolName: 'attachment_read',
  }
}
