import type { PrismaClient } from '@prisma/client'
import { KnowledgeInferenceOriginError } from '@nessie/knowledge'
import { KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'

import { enqueueQueueJob } from '@nessie/db'
import { emitAuditEvent } from '../services/audit.js'
import {
  getKnowledgeInferenceActorContext,
  requireApiKnowledgeInferenceOrigin,
} from '../services/knowledge-inference-origin.js'

// File kinds/extensions worth deterministic text extraction. The worker
// (worker/src/control/knowledge-extract.ts) re-checks extractability
// defensively — this predicate exists twice by design (once here, to avoid
// enqueuing dead-end jobs; once in the worker, in case the two ever drift).
// Markdown never reaches this predicate: knowledge-base-files.ts short-circuits
// it into a native document before a file-node page ever exists.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const EXTRACTABLE_TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'sh', 'bash', 'sql', 'toml', 'ini',
  'log', 'env', 'conf', 'properties',
])

const extensionOf = (filename: string): string | undefined =>
  filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined

export const isExtractableUpload = (filename: string, mime: string): boolean => {
  if (mime.startsWith('text/')) return true
  if (mime === 'application/pdf') return true
  if (mime === DOCX_MIME) return true
  const ext = extensionOf(filename)
  return ext ? ext === 'pdf' || ext === 'docx' || EXTRACTABLE_TEXT_EXTENSIONS.has(ext) : false
}

// Fire-and-forget, mirroring emitAuditEvent (services/audit.ts): the file
// node/version is already committed by the time this runs, so a queue-insert
// failure must never fail the request — it just means the upload stays
// un-indexed until the next version/retry.
export const enqueueKnowledgeExtract = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    pageId: string
    versionId: string
    attachmentId: string
    filename: string
    mime: string
  },
): Promise<void> => {
  if (!isExtractableUpload(input.filename, input.mime)) return
  try {
    const origin = await requireApiKnowledgeInferenceOrigin(prisma, {
      organizationId: input.organizationId,
      pageId: input.pageId,
      versionId: input.versionId,
    }, 'knowledge-file-indexer')
    await enqueueQueueJob(prisma, {
      idempotencyKey: `kb-extract:${input.pageId}:${input.versionId}`,
      payload: {
        organizationId: input.organizationId,
        pageId: input.pageId,
        versionId: input.versionId,
        attachmentId: input.attachmentId,
        origin,
      },
      topic: KNOWLEDGE_EXTRACT_TOPIC,
    })
  } catch (error) {
    if (error instanceof KnowledgeInferenceOriginError) {
      // The route will remove the stored attachment. Roll back the just-created
      // file version too; if it was the page's only version, remove the empty
      // file node so an explicit team-context error never leaves broken data.
      const pageRolledBack = await prisma.$transaction(async (tx) => {
        const versionCount = await tx.knowledgePageVersion.count({
          where: { pageId: input.pageId },
        })
        if (versionCount <= 1) {
          const deleted = await tx.knowledgePage.deleteMany({
            where: {
              id: input.pageId,
              organizationId: input.organizationId,
            },
          })
          return deleted.count > 0
        }
        await tx.knowledgePageVersion.deleteMany({
          where: {
            id: input.versionId,
            pageId: input.pageId,
          },
        })
        return false
      })
      const actorContext = getKnowledgeInferenceActorContext()
      if (pageRolledBack && actorContext) {
        // File creation records success before this asynchronous queue seam.
        // Preserve the history, but append the compensating terminal outcome so
        // audit consumers never mistake a rolled-back page for a live success.
        await emitAuditEvent(prisma, {
          actorContext,
          action: 'kb.page.created',
          resourceType: 'knowledge_page',
          resourceId: input.pageId,
          outcome: 'error',
          reason: error.code,
          metadata: {
            compensatesOutcome: 'success',
            rolledBack: true,
          },
        })
      }
      throw error
    }
    console.error('[kb.files] Failed to enqueue knowledge.extract:', input.pageId, error)
  }
}
