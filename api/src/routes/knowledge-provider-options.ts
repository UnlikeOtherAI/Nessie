import { enqueueQueueJob } from '@nessie/db'
import { knowledgeEmbeddingJobKey, type NativeKnowledgeProviderOptions } from '@nessie/knowledge'
import { KNOWLEDGE_EMBED_TOPIC } from '@nessie/schemas'
import { documentTriggerOnPagePublished, documentTriggerOnVersionCreated } from '@nessie/team-admin'

import { requireApiKnowledgeInferenceOrigin } from '../services/knowledge-inference-origin.js'
import { createKnowledgePublicationAttention } from '../services/push-attention.js'
import type { RouteDeps } from './types.js'

/**
 * The knowledge provider's hooks as the API wires them — once, for every
 * route that writes documents (the knowledge-base routes and the transfer
 * routes alike), so no door can write a version without the side effects
 * every other door has. Each runs inside the transaction that wrote what it
 * announces, so a failed enqueue rolls the save back:
 *
 * - the chunk rows' `knowledge.embed` job;
 * - a publication's attention, and the quiet window of a document trigger
 *   that fires on publish;
 * - a saved version's quiet window for a document trigger that fires on save
 *   (docs/standards/document-triggers.md). A transfer copy writes its
 *   versions without the writer, so a copy opens no window.
 */
export const apiKnowledgeProviderOptions = (
  deps: Pick<RouteDeps, 'fileService' | 'sharedModelClient'>,
): NativeKnowledgeProviderOptions => ({
  readMarkdownAttachment: async (attachmentId, organizationId) => {
    const opened = await deps.fileService.openStream(attachmentId, organizationId)
    return opened?.stream ?? null
  },
  // Enqueued inside the save transaction: the job becomes visible only when
  // the version + chunk rows commit, and a failed enqueue rolls the save back.
  onVersionChunksReplaced: async (tx, event) => {
    const origin = await requireApiKnowledgeInferenceOrigin(tx, event, 'knowledge-indexer')
    await enqueueQueueJob(tx, {
      idempotencyKey: knowledgeEmbeddingJobKey(
        event.pageId,
        event.versionId,
        deps.sharedModelClient?.embeddingModel ?? 'unresolved',
      ),
      payload: { ...event, origin },
      topic: KNOWLEDGE_EMBED_TOPIC,
    })
  },
  onPagePublished: async (tx, event) => {
    await createKnowledgePublicationAttention(tx, event)
    await documentTriggerOnPagePublished(tx, event)
  },
  onVersionCreated: documentTriggerOnVersionCreated,
})
