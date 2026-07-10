import type { PrismaClient } from '@prisma/client'
import {
  createNativeKnowledgeProvider,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import { KNOWLEDGE_EMBED_TOPIC } from '@nessie/schemas'
import { enqueueQueueJob } from '../../queue.js'

// Knowledge provider for worker tools, with the same transactional
// knowledge.embed enqueue the api wires (api/src/routes/knowledge-base-access.ts)
// — without it, agent-authored drafts would be chunked but never embedded and
// stay invisible to semantic search. Both sides call their local
// enqueueQueueJob; the underlying insert lives in each process today (known,
// pre-existing duplication of the queue write itself).
export const createWorkerKnowledgeProvider = (
  prisma: PrismaClient,
): KnowledgeProvider =>
  createNativeKnowledgeProvider(prisma, {
    onVersionChunksReplaced: async (tx, event) => {
      await enqueueQueueJob(tx, {
        idempotencyKey: `kb-embed:${event.pageId}:${event.versionId}`,
        payload: event,
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
    },
  })
