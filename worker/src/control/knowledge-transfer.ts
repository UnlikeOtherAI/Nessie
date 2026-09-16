import { Prisma, type PrismaClient } from '@prisma/client'
import {
  applyTransferCopyAttachments,
  applyTransferMove,
  clearTransferStamp,
  collectTransferAttachmentIds,
  collectTransferSubtree,
  evaluateTransferRefusals,
  isValidTransferParent,
  loadTransferSpaceScope,
  lockKnowledgeSpaceTrees,
  nextTransferPosition,
  planTransferCopy,
  rollbackTransferCopy,
  type TransferSpaceScope,
  type TransferSubtreeNode,
} from '@nessie/knowledge'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import type { KnowledgeTransferJobPayload } from '@nessie/schemas'

/**
 * `knowledge.transfer` worker handler — a cross-space move or copy of more
 * than `TRANSFER_SYNCHRONOUS_MAX_PAGES` pages (transfer.md §5).
 *
 * It takes the same two tree locks the synchronous path takes, **lower space id
 * first**, re-runs the refusals because the world may have changed since the
 * request, and processes the subtree in batches of 200 pages, each batch its
 * own transaction in parent-before-child order, writing `done`/`total` into the
 * job's `payload.progress` after each batch.
 *
 * **Partial failure differs by operation, and that difference is the design.**
 * A copy rolls everything back — every page the earlier batches created and
 * every byte they stored — because a half-copy is a document that exists twice
 * and is complete neither time. A move keeps the batches that committed: each
 * one rewrote its pages *and* their chunks, so it is internally consistent, and
 * the rows that did not move stayed exactly where they were. The tray reports
 * the counts and offers a Retry, which is an ordinary new transfer over what
 * is left.
 */

// 200 because a batch is one transaction and one transaction holding both tree
// locks is the thing that must stay short. The bound is per batch, not per job.
const TRANSFER_BATCH_PAGES = 200

const jobIdempotencyKey = (transferId: string): string => `kb-transfer:${transferId}`

// The person who dragged, not the worker: a transfer's ledger events belong to
// the act that asked for them, and `systemComponent` records which process
// carried it out.
const workerAttribution = (
  payload: KnowledgeTransferJobPayload,
  projectId: string,
): LedgerAttribution => ({
  organizationId: payload.organizationId,
  actorId: payload.actor.actorId,
  actorType: payload.actor.actorType,
  userId: payload.actor.actorType === 'user' ? payload.actor.actorId : null,
  agentId: payload.actor.actorType === 'agent' ? payload.actor.actorId : null,
  projectId,
  systemComponent: 'knowledge-transfer',
  requestId: `knowledge-transfer:${payload.transferId}`,
})

const writeProgress = async (
  prisma: PrismaClient,
  transferId: string,
  progress: { done: number; total: number; error: string | null },
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE queue_jobs
    SET payload = payload || jsonb_build_object('progress', ${JSON.stringify(progress)}::jsonb)
    WHERE idempotency_key = ${jobIdempotencyKey(transferId)}
  `)
}

const batches = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

type Prepared = {
  nodes: TransferSubtreeNode[]
  rootIds: string[]
  targetScope: TransferSpaceScope
  sourceScope: TransferSpaceScope
  startPosition: number
}

// Mutable so the failure path reports the batches that really committed rather
// than zero — for a move that number is the whole point of the tray's sentence.
type Progress = { done: number }

class TransferRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TransferRefusedError'
  }
}

/**
 * The locks, the subtree and the refusals — re-run here rather than trusted
 * from the request. A page that became an agent's core document, a target that
 * stopped being writable or a basis row added since the drag all refuse now.
 */
const prepare = async (
  prisma: PrismaClient,
  payload: KnowledgeTransferJobPayload,
): Promise<Prepared> => prisma.$transaction(async (tx) => {
  const first = await tx.knowledgePage.findFirst({
    where: { id: { in: payload.pageIds }, organizationId: payload.organizationId, deletedAt: null },
    select: { spaceId: true },
  })
  if (!first) throw new TransferRefusedError('KNOWLEDGE_PAGE_NOT_FOUND', 'Page not found')
  await lockKnowledgeSpaceTrees(tx, [first.spaceId, payload.target.spaceId])

  const [sourceScope, targetScope] = await Promise.all([
    loadTransferSpaceScope(tx, payload.organizationId, first.spaceId),
    loadTransferSpaceScope(tx, payload.organizationId, payload.target.spaceId),
  ])
  if (!sourceScope || !targetScope) {
    throw new TransferRefusedError('KNOWLEDGE_SPACE_NOT_FOUND', 'Space not found')
  }
  if (payload.target.parentPageId && !(await isValidTransferParent(tx, {
    organizationId: payload.organizationId,
    spaceId: targetScope.id,
    parentPageId: payload.target.parentPageId,
  }))) {
    throw new TransferRefusedError('KNOWLEDGE_PAGE_NOT_FOUND', 'Target folder not found')
  }

  const nodes = await collectTransferSubtree(tx, {
    organizationId: payload.organizationId,
    pageIds: payload.pageIds,
  })
  const rootIds = nodes.filter((node) => node.isRoot).map((node) => node.id)
  // The roots carry `metadata.transfer` — this job's own stamp — so the
  // "already transferring" refusal has to judge the descendants, not them.
  const refusal = await evaluateTransferRefusals(tx, {
    organizationId: payload.organizationId,
    nodes: nodes.filter((node) => !node.isRoot),
    sourceProjectId: sourceScope.projectId,
    targetSpace: targetScope,
    parentPageId: payload.target.parentPageId,
  })
  if (refusal) throw new TransferRefusedError(refusal.code, refusal.message)

  return {
    nodes,
    rootIds,
    targetScope,
    sourceScope,
    startPosition: await nextTransferPosition(tx, {
      organizationId: payload.organizationId,
      spaceId: targetScope.id,
      parentPageId: payload.target.parentPageId,
    }),
  }
})

const runMove = async (
  deps: { fileService: FileService; prisma: PrismaClient },
  payload: KnowledgeTransferJobPayload,
  prepared: Prepared,
  progress: Progress,
): Promise<void> => {
  const { prisma, fileService } = deps
  const attribution = workerAttribution(payload, prepared.targetScope.projectId)
  const rootSet = new Set(prepared.rootIds)
  // Parent before child, so a batch never re-parents a page whose new parent is
  // still in the old space.
  for (const batch of batches(prepared.nodes, TRANSFER_BATCH_PAGES)) {
    const pageIds = batch.map((node) => node.id)
    const rootsInBatch = pageIds.filter((id) => rootSet.has(id))
    const attachmentIds = await prisma.$transaction(async (tx) => {
      const ids = await collectTransferAttachmentIds(tx, {
        organizationId: payload.organizationId,
        pageIds,
      })
      await applyTransferMove(tx, {
        organizationId: payload.organizationId,
        targetSpace: prepared.targetScope,
        pageIds,
        rootIds: rootsInBatch,
        parentPageId: payload.target.parentPageId,
        startPosition: prepared.startPosition + progress.done,
      })
      return ids
    })
    // The ledger pair is outside the batch transaction on purpose: it is the
    // one part of a move whose two halves sum to zero on their own, so a
    // failure between the rows and the events cannot make usage wrong in a
    // direction that matters, and `FileService` owns its own writes.
    await fileService.reassignScope(attachmentIds, {
      organizationId: payload.organizationId,
      from: {
        projectId: prepared.sourceScope.projectId,
        teamId: prepared.sourceScope.teamId,
        spaceId: prepared.sourceScope.id,
      },
      to: {
        projectId: prepared.targetScope.projectId,
        teamId: prepared.targetScope.teamId,
        spaceId: prepared.targetScope.id,
      },
      attribution,
    })
    progress.done += batch.length
    await writeProgress(prisma, payload.transferId, {
      done: progress.done,
      total: prepared.nodes.length,
      error: null,
    })
  }
}

const runCopy = async (
  deps: { fileService: FileService; prisma: PrismaClient },
  payload: KnowledgeTransferJobPayload,
  prepared: Prepared,
  progress: Progress,
): Promise<void> => {
  const { prisma, fileService } = deps
  const attribution = workerAttribution(payload, prepared.targetScope.projectId)
  const createdPageIds: string[] = []
  try {
    for (const batch of batches(prepared.nodes, TRANSFER_BATCH_PAGES)) {
      const plan = await prisma.$transaction(async (tx) => planTransferCopy(tx, {
        organizationId: payload.organizationId,
        targetSpace: prepared.targetScope,
        nodes: batch,
        parentPageId: payload.target.parentPageId,
        startPosition: prepared.startPosition + progress.done,
        actor: payload.actor,
        sourceSpaceName: prepared.sourceScope.name,
      }))
      createdPageIds.push(...plan.idMap.map((entry) => entry.pageId))
      await applyTransferCopyAttachments(fileService, prisma, {
        organizationId: payload.organizationId,
        targetSpace: prepared.targetScope,
        work: plan.attachmentWork,
        actorUserId: payload.actor.actorType === 'user' ? payload.actor.actorId : null,
        attribution,
      })
      progress.done += batch.length
      await writeProgress(prisma, payload.transferId, {
        done: progress.done,
        total: prepared.nodes.length,
        error: null,
      })
    }
  } catch (error) {
    // A copy rolls everything back. The bytes each batch stored were already
    // freed by `applyTransferCopyAttachments`' own failure path for the batch
    // that threw; the earlier batches' attachments go with their pages here.
    for (const pageId of createdPageIds) {
      await fileService
        .purgeKnowledgePageFiles(pageId, payload.organizationId, attribution)
        .catch(() => undefined)
    }
    await rollbackTransferCopy(prisma, {
      organizationId: payload.organizationId,
      pageIds: createdPageIds,
    }).catch(() => undefined)
    throw error
  }
}

export const executeKnowledgeTransferJob = async (
  deps: { fileService: FileService; prisma: PrismaClient },
  payload: KnowledgeTransferJobPayload,
): Promise<void> => {
  const { prisma } = deps
  const progress: Progress = { done: 0 }
  let prepared: Prepared | null = null
  try {
    prepared = await prepare(prisma, payload)
    if (payload.operation === 'move') {
      await runMove(deps, payload, prepared, progress)
    } else {
      // A rolled-back copy committed nothing, so its reported progress is zero
      // however far it got.
      await runCopy(deps, payload, prepared, progress)
      progress.done = prepared.nodes.length
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The stamp always comes off: a row left reading "Moving…" refuses every
    // edit forever, which is a worse outcome than the failure itself.
    await clearTransferStamp(prisma, {
      organizationId: payload.organizationId,
      pageIds: payload.pageIds,
    }).catch(() => undefined)
    await writeProgress(prisma, payload.transferId, {
      done: payload.operation === 'copy' ? 0 : progress.done,
      total: prepared?.nodes.length ?? 0,
      error: message,
    }).catch(() => undefined)
    throw error
  }
  await clearTransferStamp(prisma, {
    organizationId: payload.organizationId,
    pageIds: payload.pageIds,
  })
}
