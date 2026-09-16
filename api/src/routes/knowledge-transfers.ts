import { randomUUID } from 'node:crypto'

import { Prisma } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { enqueueQueueJob } from '@nessie/db'
import {
  canReadSpace,
  canWriteSpace,
  knowledgeEmbeddingJobKey,
  type NativeKnowledgeProviderOptions,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import {
  KNOWLEDGE_EMBED_TOPIC,
  KNOWLEDGE_TRANSFER_TOPIC,
  TransferPagesBodySchema,
  TransferResultSchema,
  TransferStatusSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { requireApiKnowledgeInferenceOrigin } from '../services/knowledge-inference-origin.js'
import {
  createKnowledgeAccess,
  requestIds,
  requireKnowledgePolicy,
  type KnowledgeRouteDeps,
} from './knowledge-base-access.js'
import { sendKnowledgeMutationError } from './knowledge-base-errors.js'
import {
  finishTransferCopy,
  runTransferTransaction,
  transferJobIdempotencyKey,
  type TransferOutcome,
} from './knowledge-transfer-run.js'
import { sendFileServiceError } from './uploads.js'

/**
 * Moving and copying pages between root folders (spaces).
 *
 * This is new API surface, not a widened `movePage`: the provider's move
 * requires the new parent to be in the page's own space and never changes
 * `spaceId`.
 *
 * The load-bearing fact: a move rewrites the pages **and every chunk's scope
 * mirror** in one transaction. Retrieval reads the chunk row alone, so a chunk
 * left on the old scope would keep answering the old audience — a moved
 * document would still be findable by people who can no longer open it. The
 * annotations' denormalised `spaceId` and the storage ledger move with them.
 *
 * Up to `TRANSFER_SYNCHRONOUS_MAX_PAGES` the whole thing is one request; above
 * it the route stamps the roots, enqueues `knowledge.transfer` and answers 202.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/transfer.md §2–5.
 *
 *   POST /api/knowledge-base/transfers
 *   GET  /api/knowledge-base/transfers/:transferId
 */

// `TransferPagesBodySchema.acknowledged` is `z.literal(true)`, so a caller that
// omits it fails schema validation with a generic VALIDATION_ERROR. The design
// gives that case its own code, which the client never sees but an API caller
// must, so the wire is parsed leniently here and the literal is re-checked by
// name. The Wave 0 schema still validates the accepted body below.
const LenientTransferBodySchema = TransferPagesBodySchema
  .omit({ acknowledged: true })
  .extend({ acknowledged: z.boolean().optional() })

const TransferParamsSchema = z.object({ transferId: z.string().uuid() })

type JobStatusRow = {
  status: string
  error_message: string | null
  payload: Prisma.JsonValue
}

// `queue_jobs` has four statuses; a transfer's tray speaks four of its own.
// A `pending` row that already carries an attempt is a retry the queue is
// holding, which is still "queued" to the person watching.
const transferStatusFromJob = (status: string): 'queued' | 'running' | 'done' | 'failed' => {
  switch (status) {
    case 'processing':
      return 'running'
    case 'done':
      return 'done'
    case 'dead':
      return 'failed'
    default:
      return 'queued'
  }
}

const readJobProgress = (
  payload: Prisma.JsonValue,
): { operation: 'move' | 'copy'; done: number; total: number; error: string | null } => {
  const record = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? (payload as Record<string, unknown>)
    : {}
  const progress = (record['progress'] && typeof record['progress'] === 'object')
    ? (record['progress'] as Record<string, unknown>)
    : {}
  return {
    operation: record['operation'] === 'copy' ? 'copy' : 'move',
    done: typeof progress['done'] === 'number' ? progress['done'] : 0,
    total: typeof progress['total'] === 'number' ? progress['total'] : 0,
    error: typeof progress['error'] === 'string' ? progress['error'] : null,
  }
}

export const registerKnowledgeTransferRoutes = (
  app: FastifyInstance,
  deps: KnowledgeRouteDeps,
): void => {
  const { prisma, requireActorContext, fileService } = deps
  const { provider, buildViewer } = createKnowledgeAccess(deps)

  // A copied published document is chunked inside the copy's own transaction
  // and must enqueue its embed pass there too, exactly as an ordinary save
  // does — otherwise the copy is chunked but never embedded and stays invisible
  // to semantic search, which is the opposite of the "searchable within
  // seconds" the copy-by-content-hash path exists to give it.
  const providerOptions: NativeKnowledgeProviderOptions = {
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
  }

  app.post('/api/knowledge-base/transfers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const body = parseInput(LenientTransferBodySchema, request.body, reply)
    if (!body) return reply
    if (body.acknowledged !== true) {
      sendApiError(
        reply,
        400,
        'TRANSFER_NOT_ACKNOWLEDGED',
        'A transfer must acknowledge who will see the items in their new home',
      )
      return reply
    }
    TransferPagesBodySchema.parse({ ...body, acknowledged: true })

    const decision = await requireKnowledgePolicy(
      deps,
      actorContext,
      reply,
      'knowledge_page',
      body.operation === 'copy' ? 'create' : 'edit',
    )
    if (!decision) return reply

    const organizationId = actorContext.tenant.organizationId
    const viewer = await buildViewer(actorContext)
    const pageIds = Array.from(new Set(body.pageIds))

    // Source facts first, outside the transaction: they decide 404/403 and
    // nothing here writes, so a refused transfer never takes a tree lock.
    const sources = await prisma.knowledgePage.findMany({
      where: { id: { in: pageIds }, organizationId, deletedAt: null },
      select: { id: true, spaceId: true },
    })
    if (sources.length !== pageIds.length) {
      sendApiError(reply, 404, 'KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
      return reply
    }
    const sourceSpaceIds = Array.from(new Set(sources.map((page) => page.spaceId)))
    if (sourceSpaceIds.length > 1) {
      sendApiError(
        reply,
        400,
        'TRANSFER_MIXED_SOURCES',
        'Move or copy items from one root folder at a time',
      )
      return reply
    }
    const sourceSpaceId = sourceSpaceIds[0] as string
    const [sourceSpace, targetSpace] = await Promise.all([
      provider.getSpace(organizationId, sourceSpaceId),
      provider.getSpace(organizationId, body.target.spaceId),
    ])
    if (!sourceSpace || !targetSpace) {
      sendApiError(reply, 404, 'KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
      return reply
    }
    // A copy only reads its source — a person with read access to a shared root
    // may take a copy home. A move removes items from it and needs write.
    const sourceOk = body.operation === 'copy'
      ? canReadSpace(sourceSpace, viewer)
      : canWriteSpace(sourceSpace, viewer)
    if (!sourceOk) {
      sendApiError(
        reply,
        403,
        'POLICY_DENIED',
        body.operation === 'copy'
          ? `You can't read items in ${sourceSpace.name}.`
          : `You can't remove items from ${sourceSpace.name}.`,
      )
      return reply
    }
    if (!canWriteSpace(targetSpace, viewer)) {
      sendApiError(
        reply,
        403,
        'TRANSFER_TARGET_NOT_WRITABLE',
        `You can't add items to ${targetSpace.name}.`,
      )
      return reply
    }
    if (targetSpace.id === sourceSpaceId) {
      sendApiError(
        reply,
        400,
        'TRANSFER_INTO_SELF',
        'Those items are already in that root folder.',
      )
      return reply
    }

    const transferId = randomUUID()
    const attribution = attributionFromActorContext(actorContext)
    let outcome: TransferOutcome
    try {
      outcome = await prisma.$transaction(async (tx) => runTransferTransaction(tx, {
        actorContext,
        attribution,
        organizationId,
        operation: body.operation,
        pageIds,
        parentPageId: body.target.parentPageId,
        providerOptions,
        sourceSpace,
        targetSpaceId: targetSpace.id,
        transferId,
      }), { timeout: 120_000 })
    } catch (error) {
      return sendKnowledgeMutationError(request, reply, error, {
        code: 'KNOWLEDGE_TRANSFER_FAILED',
        message: 'The transfer could not be completed',
        statusCode: 400,
      })
    }

    if (outcome.kind === 'refusal') {
      sendApiError(reply, outcome.status, outcome.code, outcome.message)
      return reply
    }

    if (outcome.kind === 'queued') {
      await enqueueQueueJob(prisma, {
        idempotencyKey: transferJobIdempotencyKey(transferId),
        // One attempt: a failed transfer is reported and retried by the person
        // from the tray, not silently re-run by the queue over rows a partial
        // move has already changed.
        maxAttempts: 1,
        payload: {
          organizationId,
          transferId,
          operation: body.operation,
          pageIds,
          target: { spaceId: targetSpace.id, parentPageId: body.target.parentPageId },
          actor: {
            actorId: actorContext.actor.actorId,
            actorType: actorContext.actor.actorType === 'agent' ? 'agent' : 'user',
          },
          acknowledgedAudience: true,
          progress: { done: 0, total: outcome.total, error: null },
        },
        topic: KNOWLEDGE_TRANSFER_TOPIC,
      })
      reply.code(202)
      return createApiResponse(TransferResultSchema.parse({
        status: 'queued',
        operation: body.operation,
        transferId,
        descendants: outcome.descendants,
      }))
    }

    if (outcome.kind === 'copy') {
      try {
        await finishTransferCopy(prisma, fileService, outcome)
      } catch (error) {
        if (sendFileServiceError(reply, error)) return reply
        return sendKnowledgeMutationError(request, reply, error, {
          code: 'KNOWLEDGE_TRANSFER_FAILED',
          message: 'The copy could not be completed',
          statusCode: 400,
        })
      }
    } else {
      // A move's bytes stay put; only their accounted scope changes. The pair
      // sums to zero, so no quota check runs.
      await fileService.reassignScope(outcome.attachmentIds, {
        organizationId,
        from: {
          projectId: sourceSpace.projectId,
          teamId: sourceSpace.teamId,
          spaceId: sourceSpace.id,
        },
        to: {
          projectId: outcome.targetScope.projectId,
          teamId: outcome.targetScope.teamId,
          spaceId: outcome.targetScope.id,
        },
        attribution,
      })
    }

    for (const event of outcome.auditEvents) {
      await emitAuditEvent(prisma, {
        actorContext,
        action: event.action,
        resourceType: 'knowledge_page',
        resourceId: event.resourceId,
        outcome: 'success',
        metadata: event.metadata,
        ...requestIds(request),
      })
    }

    return createApiResponse(TransferResultSchema.parse({
      status: 'done',
      operation: body.operation,
      pages: outcome.pages,
      descendants: outcome.descendants,
      sharesEnded: outcome.sharesEnded,
    }))
  })

  app.get('/api/knowledge-base/transfers/:transferId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const params = parseInput(TransferParamsSchema, request.params, reply, 'params')
    if (!params) return reply

    const rows = await prisma.$queryRaw<JobStatusRow[]>(Prisma.sql`
      SELECT status, error_message, payload
      FROM queue_jobs
      WHERE idempotency_key = ${transferJobIdempotencyKey(params.transferId)}
      LIMIT 1
    `)
    const row = rows[0]
    const payloadOrg = row
      && row.payload
      && typeof row.payload === 'object'
      && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)['organizationId']
      : undefined
    // A transfer belonging to another tenant is indistinguishable here from one
    // that never existed.
    if (!row || payloadOrg !== actorContext.tenant.organizationId) {
      sendApiError(reply, 404, 'TRANSFER_NOT_FOUND', 'Transfer not found')
      return reply
    }
    const progress = readJobProgress(row.payload)
    return createApiResponse(TransferStatusSchema.parse({
      transferId: params.transferId,
      operation: progress.operation,
      status: transferStatusFromJob(row.status),
      done: progress.done,
      total: progress.total,
      error: progress.error ?? row.error_message ?? null,
    }))
  })
}
