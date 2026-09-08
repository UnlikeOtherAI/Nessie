import {
  createNativeKnowledgeProvider,
  knowledgeEmbeddingJobKey,
  type KnowledgeProvider,
} from '@nessie/knowledge'
import {
  KNOWLEDGE_EMBED_TOPIC,
  type KnowledgeInferenceOrigin,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../../queue.js'
import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const buildOrigin = (
  context: BuiltinToolRuntimeContext,
): KnowledgeInferenceOrigin | null => {
  const userId =
    context.run.originatingUserId
    ?? context.actorContext.actionContext.effectiveUserId
    ?? (
      context.actorContext.actor.actorType === 'user'
        ? context.actorContext.actor.actorId
        : null
    )
  const teamId =
    context.actorContext.tenant.teamId
    ?? context.actorContext.actionContext.teamId
    ?? null
  if (!userId || !teamId) {
    return null
  }
  return {
    actorId: context.actorContext.actor.actorId,
    actorType: context.actorContext.actor.actorType,
    agentId: context.agentId,
    correlationId: context.actorContext.actionContext.correlationId,
    requestId: context.actorContext.actionContext.requestId,
    runId: context.run.id,
    teamId,
    userId,
  }
}

// Knowledge provider for worker tools, with the same transactional
// knowledge.embed enqueue the api wires (api/src/routes/knowledge-base-access.ts)
// — without it, agent-authored drafts would be chunked but never embedded and
// stay invisible to semantic search. Both sides call their local
// enqueueQueueJob; the underlying insert lives in each process today (known,
// pre-existing duplication of the queue write itself).
export const createWorkerKnowledgeProvider = (
  context: BuiltinToolRuntimeContext,
): KnowledgeProvider =>
  createNativeKnowledgeProvider(context.prisma, {
    readMarkdownAttachment: async (attachmentId, organizationId) => {
      const opened = await fileServiceFor(context.prisma).openStream(attachmentId, organizationId)
      return opened?.stream ?? null
    },
    onVersionChunksReplaced: async (tx, event) => {
      const origin = buildOrigin(context)
      if (!origin) {
        throw new Error(
          'KNOWLEDGE_INFERENCE_ORIGIN_REQUIRED: '
          + 'agent knowledge indexing requires an originating user and team',
        )
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: knowledgeEmbeddingJobKey(
          event.pageId,
          event.versionId,
          context.modelClient?.embeddingModel ?? 'unresolved',
        ),
        payload: { ...event, origin },
        topic: KNOWLEDGE_EMBED_TOPIC,
      })
    },
  })
