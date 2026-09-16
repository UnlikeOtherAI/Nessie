import type { PrismaClient } from '@prisma/client'
import { isExtractableUpload, KnowledgeInferenceOriginError } from '@nessie/knowledge'
import { KNOWLEDGE_EXTRACT_TOPIC } from '@nessie/schemas'

import { enqueueQueueJob } from '@nessie/db'
import { emitAuditEvent } from '../services/audit.js'
import {
  getKnowledgeInferenceActorContext,
  requireApiKnowledgeInferenceOrigin,
} from '../services/knowledge-inference-origin.js'

// Which uploads are worth deterministic text extraction now lives in
// @nessie/knowledge (`extractable.ts`), shared by this route, the worker's
// defensive re-check, and the Finder's indexing status — which says "Not
// indexed — unsupported" out loud and would have been lying whenever the two
// former copies of the list drifted. Re-exported here so existing importers of
// this module keep one import surface.
export { isExtractableUpload }

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
