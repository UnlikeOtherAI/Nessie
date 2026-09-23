import type { PrismaClient } from '@prisma/client'
import type { ToolCallAttachment, UoaSessionIdentity } from '@nessie/schemas'

import { canReadRunExecutorImages } from './attachments.js'

/** Who is reading the calls: the same three facts the attachment routes ask. */
export type ToolCallAttachmentViewer = {
  organizationId: string
  uoaIdentity: UoaSessionIdentity | undefined
  userId: string
}

/**
 * The images each tool call returned, for a person reading the calls — the
 * agent page's tool execution log and the thought-process dialog's tool lines.
 *
 * A call's images are the attachments of the executor command it recorded:
 * ToolCall → ExecutorCommand (`toolCallId`) → Attachment (`executorCommandId`),
 * in upload order, which is the order the result names them. They are refs
 * only; the bytes are the ordinary attachment routes' to serve, and a ref is
 * listed only where those routes would serve it to this viewer — the same
 * run-level question `canAccessAttachment` asks, once per run — so no surface
 * draws a thumbnail that answers 404. Without a viewer nothing is listed.
 */
export const loadToolCallAttachments = async (
  prisma: PrismaClient,
  toolCalls: ReadonlyArray<{ id: string; runId: string }>,
  viewer: ToolCallAttachmentViewer | undefined,
): Promise<Map<string, ToolCallAttachment[]>> => {
  const byToolCall = new Map<string, ToolCallAttachment[]>()
  if (!viewer || toolCalls.length === 0) return byToolCall

  const runByToolCall = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall.runId]))
  const found = await prisma.executorCommand.findMany({
    where: { toolCallId: { in: [...runByToolCall.keys()] } },
    select: { id: true, toolCall: { select: { runId: true } }, toolCallId: true },
  })
  // A call is asked about as part of its run; one that turns out to belong to
  // another run answers nothing here.
  const commands = found.filter((command) => runByToolCall.get(command.toolCallId) === command.toolCall.runId)
  if (commands.length === 0) return byToolCall

  const toolCallByCommand = new Map(commands.map((command) => [command.id, command.toolCallId]))
  const rows = await prisma.attachment.findMany({
    where: {
      executorCommandId: { in: [...toolCallByCommand.keys()] },
      organizationId: viewer.organizationId,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      contentByteLength: true,
      executorCommandId: true,
      filename: true,
      id: true,
      mime: true,
      thumbnailKey: true,
    },
  })

  const readableRuns = new Map<string, Promise<boolean>>()
  const runReadable = (runId: string): Promise<boolean> => {
    let answer = readableRuns.get(runId)
    if (!answer) {
      answer = canReadRunExecutorImages(prisma, { ...viewer, runId })
      readableRuns.set(runId, answer)
    }
    return answer
  }

  for (const row of rows) {
    const toolCallId = row.executorCommandId ? toolCallByCommand.get(row.executorCommandId) : undefined
    const runId = toolCallId ? runByToolCall.get(toolCallId) : undefined
    if (!toolCallId || !runId || !row.contentByteLength) continue
    if (!(await runReadable(runId))) continue
    const listed = byToolCall.get(toolCallId) ?? []
    listed.push({
      attachmentId: row.id,
      byteLength: row.contentByteLength,
      filename: row.filename,
      hasThumbnail: row.thumbnailKey !== null,
      mimeType: row.mime,
    })
    byToolCall.set(toolCallId, listed)
  }
  return byToolCall
}
