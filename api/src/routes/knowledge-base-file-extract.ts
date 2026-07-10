import type { PrismaClient } from '@prisma/client'
import { KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'

import { enqueueQueueJob } from '../queue/pgqueue.js'

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
    await enqueueQueueJob(prisma, {
      idempotencyKey: `kb-extract:${input.pageId}:${input.versionId}`,
      payload: {
        organizationId: input.organizationId,
        pageId: input.pageId,
        versionId: input.versionId,
        attachmentId: input.attachmentId,
      },
      topic: KNOWLEDGE_EXTRACT_TOPIC,
    })
  } catch (error) {
    console.error('[kb.files] Failed to enqueue knowledge.extract:', input.pageId, error)
  }
}
