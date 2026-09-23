import { executorResultImageReferences } from '@nessie/executor-manage'
import type { PrismaClient } from '@prisma/client'

import type { ExecutorResultImages } from './executor-result-presentation.js'
import type { ToolImageRef } from './tool-images.js'
import type { AgenticToolResult } from './tools.js'

const parseDocument = (output: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(output)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The attachments an `mcp.call` result's images were kept as.
 *
 * The daemon leaves each image in the result as a reference — digest, type
 * and size, no bytes — and uploads the bytes for its command before the
 * receipt; result intake refuses a reference with nothing behind it
 * (`assertExecutorResultImagesKept`). The command is found by the ToolCall
 * the toolset recorded it under, in this run, and a reference resolves only
 * to an attachment of that command of the type and size it states. Nothing
 * here throws: a lookup that fails resolves nothing, the model is told Nessie
 * does not hold the image, and the run goes on.
 */
export const resolveExecutorResultImages = async (
  prisma: PrismaClient,
  runId: string,
  result: Pick<AgenticToolResult, 'output' | 'toolCallRecordId'>,
): Promise<ExecutorResultImages> => {
  const images = new Map<string, ToolImageRef>()
  if (!result.toolCallRecordId) return images
  try {
    const references = executorResultImageReferences(parseDocument(result.output))
    if (references.length === 0) return images
    const command = await prisma.executorCommand.findFirst({
      where: { toolCall: { id: result.toolCallRecordId, runId } },
      select: { id: true },
    })
    if (!command) return images
    const kept = await prisma.attachment.findMany({
      where: {
        contentDigest: { in: references.map((reference) => reference.attachmentDigest) },
        executorCommandId: command.id,
      },
      select: { contentByteLength: true, contentDigest: true, id: true, mime: true },
    })
    for (const reference of references) {
      const row = kept.find((candidate) => candidate.contentDigest === reference.attachmentDigest)
      if (!row || row.mime !== reference.mimeType || row.contentByteLength !== reference.byteLength) continue
      images.set(reference.attachmentDigest, {
        attachmentId: row.id,
        byteLength: reference.byteLength,
        mimeType: row.mime,
      })
    }
  } catch (error) {
    console.warn('[worker] could not resolve the images of an executor result', error)
  }
  return images
}
