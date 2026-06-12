import { randomUUID } from 'node:crypto'
import { loadConfig } from '@nessie/config'
import { getStorage, type StorageConfig } from '@nessie/runtime'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  isDelegatingPersonalAssistant,
} from './access.js'
import { clampLimit, formatSection, truncate } from './tool-output.js'

const ATTACHMENT_READ_MAX_TEXT_BYTES = 64 * 1024

const attachmentKindFromMime = (mime: string): string => {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  return 'file'
}

const isTextLikeMime = (mime: string): boolean =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'application/xml' ||
  mime.endsWith('+json') ||
  mime.endsWith('+xml')

const attachmentStorageConfig = (): StorageConfig => {
  const config = loadConfig()
  return {
    provider: config.storage.provider,
    bucket: config.storage.bucket,
    localPath: config.storage.localPath,
  }
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

  const storageKey = `${organizationId}/${randomUUID()}`
  const storage = getStorage(attachmentStorageConfig())
  await storage.put(storageKey, bytes, mime)

  const attachment = await context.prisma.attachment.create({
    data: {
      organizationId,
      uploaderId,
      kind: attachmentKindFromMime(mime),
      mime,
      filename,
      sizeBytes: bytes.byteLength,
      storageKey,
    },
    select: { id: true, filename: true, mime: true, sizeBytes: true },
  })

  return {
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

  const metadataLines = [
    `id=${attachment.id}`,
    `filename=${attachment.filename}`,
    `mime=${attachment.mime}`,
    `kind=${attachment.kind}`,
    `sizeBytes=${attachment.sizeBytes}`,
  ]

  if (
    !isTextLikeMime(attachment.mime) ||
    attachment.sizeBytes > ATTACHMENT_READ_MAX_TEXT_BYTES
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

  const storage = getStorage(attachmentStorageConfig())
  const bytes = await storage.get(attachment.storageKey)
  if (!bytes) {
    return {
      inputSummary: `id=${id}`,
      outputPreview: [...metadataLines, 'content=(stored bytes missing)'].join('\n'),
      toolName: 'attachment_read',
    }
  }

  return {
    inputSummary: `id=${id}`,
    outputPreview: [
      ...metadataLines,
      'content:',
      truncate(bytes.toString('utf8'), 8000),
    ].join('\n'),
    toolName: 'attachment_read',
  }
}
