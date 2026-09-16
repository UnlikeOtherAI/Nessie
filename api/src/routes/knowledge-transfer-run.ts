import type { Prisma, PrismaClient } from '@prisma/client'
import {
  applyTransferCopyAttachments,
  applyTransferMove,
  collectTransferAttachmentIds,
  collectTransferSubtree,
  evaluateTransferRefusals,
  isValidTransferParent,
  loadTransferSpaceScope,
  lockKnowledgeSpaceTrees,
  nextTransferPosition,
  planTransferCopy,
  rollbackTransferCopy,
  stampTransferOnRoots,
  type KnowledgeSpaceRecord,
  type NativeKnowledgeProviderOptions,
  type TransferCopyPlan,
  type TransferSpaceScope,
} from '@nessie/knowledge'
import type { FileService, LedgerAttribution } from '@nessie/runtime'
import { TRANSFER_SYNCHRONOUS_MAX_PAGES } from '@nessie/schemas'
import type { AuditAction, AuthorizedActionContext } from '@nessie/schemas'

/**
 * The body of a transfer request, from both tree locks to the last audit row.
 *
 * Split out of `knowledge-transfers.ts` only for size: the route decides
 * statuses and shapes replies, this decides rows. Every refusal, the subtree
 * walk and the two operations themselves live in `@nessie/knowledge` so the
 * worker's batched path runs the same statements rather than a second copy of
 * them.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/transfer.md §2–5.
 */

export const transferJobIdempotencyKey = (transferId: string): string =>
  `kb-transfer:${transferId}`

export type TransferAuditEvent = {
  action: AuditAction
  resourceId: string
  metadata: Record<string, unknown>
}

export type TransferOutcome =
  | { kind: 'refusal'; status: number; code: string; message: string }
  | { kind: 'queued'; transferId: string; descendants: number; total: number }
  | {
    kind: 'move'
    pages: Array<{ sourcePageId: string; pageId: string }>
    descendants: number
    sharesEnded: number
    targetScope: TransferSpaceScope
    auditEvents: TransferAuditEvent[]
  }
  | {
    kind: 'copy'
    pages: Array<{ sourcePageId: string; pageId: string }>
    descendants: number
    sharesEnded: 0
    plan: TransferCopyPlan
    targetScope: TransferSpaceScope
    organizationId: string
    actorUserId: string | null
    attribution: LedgerAttribution
    auditEvents: TransferAuditEvent[]
  }

export type RunTransferInput = {
  actorContext: AuthorizedActionContext
  attribution: LedgerAttribution
  fileService: FileService
  organizationId: string
  operation: 'move' | 'copy'
  pageIds: string[]
  parentPageId: string | null
  providerOptions: NativeKnowledgeProviderOptions
  sourceSpace: KnowledgeSpaceRecord
  targetSpaceId: string
  transferId: string
}

// The refusal codes the design fixes, each with the status it answers on.
const REFUSAL_STATUS: Record<string, number> = {
  KNOWLEDGE_PAGE_NOT_FOUND: 404,
  KNOWLEDGE_MUTATION_CONFLICT: 409,
  TRANSFER_INTO_SELF: 400,
  TRANSFER_AGENT_CORE_DOCUMENT: 403,
  TRANSFER_TASK_BOUND: 403,
  TRANSFER_WIDENS_BASIS: 403,
}

export const runTransferTransaction = async (
  tx: Prisma.TransactionClient,
  input: RunTransferInput,
): Promise<TransferOutcome> => {
  // Lower space id first, both spaces, before anything is read that a
  // concurrent transfer could change under us.
  await lockKnowledgeSpaceTrees(tx, [input.sourceSpace.id, input.targetSpaceId])
  const targetScope = await loadTransferSpaceScope(tx, input.organizationId, input.targetSpaceId)
  if (!targetScope) {
    return {
      kind: 'refusal',
      status: 404,
      code: 'KNOWLEDGE_SPACE_NOT_FOUND',
      message: 'Space not found',
    }
  }
  if (input.parentPageId && !(await isValidTransferParent(tx, {
    organizationId: input.organizationId,
    spaceId: targetScope.id,
    parentPageId: input.parentPageId,
  }))) {
    return {
      kind: 'refusal',
      status: 404,
      code: 'KNOWLEDGE_PAGE_NOT_FOUND',
      message: 'Target folder not found',
    }
  }

  const nodes = await collectTransferSubtree(tx, {
    organizationId: input.organizationId,
    pageIds: input.pageIds,
  })
  const refusal = await evaluateTransferRefusals(tx, {
    organizationId: input.organizationId,
    nodes,
    sourceProjectId: input.sourceSpace.projectId,
    targetSpace: targetScope,
    parentPageId: input.parentPageId,
  })
  if (refusal) {
    return {
      kind: 'refusal',
      status: REFUSAL_STATUS[refusal.code] ?? 400,
      code: refusal.code,
      message: refusal.message,
    }
  }

  const rootIds = nodes.filter((node) => node.isRoot).map((node) => node.id)
  const descendants = nodes.length - rootIds.length

  // Above the bound this becomes a job: the roots are stamped so their rows
  // read "Moving…"/"Copying…" and refuse edits, and the route enqueues.
  if (nodes.length > TRANSFER_SYNCHRONOUS_MAX_PAGES) {
    await stampTransferOnRoots(tx, {
      organizationId: input.organizationId,
      rootIds,
      transfer: {
        transferId: input.transferId,
        operation: input.operation,
        targetSpaceId: targetScope.id,
        startedAt: new Date().toISOString(),
      },
    })
    return {
      kind: 'queued',
      transferId: input.transferId,
      descendants,
      total: nodes.length,
    }
  }

  const startPosition = await nextTransferPosition(tx, {
    organizationId: input.organizationId,
    spaceId: targetScope.id,
    parentPageId: input.parentPageId,
  })

  if (input.operation === 'move') {
    // Read before the rows change: after the update these attachments'
    // `knowledgePageId` resolves to the new scope and the `move.out` half would
    // name the wrong one.
    const attachmentIds = await collectTransferAttachmentIds(tx, {
      organizationId: input.organizationId,
      pageIds: nodes.map((node) => node.id),
    })
    const moved = await applyTransferMove(tx, {
      organizationId: input.organizationId,
      targetSpace: targetScope,
      pageIds: nodes.map((node) => node.id),
      rootIds,
      parentPageId: input.parentPageId,
      startPosition,
    })
    // In the same transaction as the rows and the chunk mirrors: the pair sums
    // to zero and takes no admission lock, so there is no reason for a move to
    // commit its pages and then discover it cannot re-home their bytes.
    await input.fileService.reassignScope(attachmentIds, {
      organizationId: input.organizationId,
      from: {
        projectId: input.sourceSpace.projectId,
        teamId: input.sourceSpace.teamId,
        spaceId: input.sourceSpace.id,
      },
      to: {
        projectId: targetScope.projectId,
        teamId: targetScope.teamId,
        spaceId: targetScope.id,
      },
      attribution: input.attribution,
      client: tx,
    })
    return {
      kind: 'move',
      pages: rootIds.map((id) => ({ sourcePageId: id, pageId: id })),
      descendants,
      sharesEnded: moved.endedShares.length,
      targetScope,
      auditEvents: [
        ...rootIds.map((id, index) => ({
          action: 'kb.page.moved' as AuditAction,
          resourceId: id,
          metadata: {
            fromSpaceId: input.sourceSpace.id,
            toSpaceId: targetScope.id,
            parentPageId: input.parentPageId,
            position: startPosition + index,
            descendants,
            sharesEnded: moved.endedShares.length,
          },
        })),
        // A move out of a personal space ends every share on the subtree. That
        // is a revocation, so it is told in the sharing surface's own words
        // (`by: 'moved'` is the third voice beside 'sharer' and 'grantee'),
        // against the page that actually lost the grant — not summarised in
        // the mover's metadata, where no audit read for a grantee would find it.
        ...moved.endedShares.map((share) => ({
          action: 'kb.page.unshared' as AuditAction,
          resourceId: share.pageId,
          metadata: {
            granteeUserId: share.granteeUserId,
            spaceId: share.spaceId,
            by: 'moved',
          },
        })),
      ],
    }
  }

  const plan = await planTransferCopy(tx, {
    organizationId: input.organizationId,
    targetSpace: targetScope,
    nodes,
    parentPageId: input.parentPageId,
    startPosition,
    actor: {
      actorId: input.actorContext.actor.actorId,
      actorType: input.actorContext.actor.actorType === 'agent' ? 'agent' : 'user',
    },
    sourceSpaceName: input.sourceSpace.name,
    providerOptions: input.providerOptions,
  })
  const kindBySourceId = new Map(nodes.map((node) => [node.id, node.kind]))
  const rootSet = new Set(rootIds)
  return {
    kind: 'copy',
    pages: plan.idMap.filter((entry) => rootSet.has(entry.sourcePageId)),
    descendants,
    sharesEnded: 0,
    plan,
    targetScope,
    organizationId: input.organizationId,
    actorUserId: input.actorContext.actionContext.effectiveUserId
      ?? (input.actorContext.actor.actorType === 'user'
        ? input.actorContext.actor.actorId
        : null),
    attribution: input.attribution,
    auditEvents: plan.idMap.map((entry) => ({
      action: 'kb.page.created' as AuditAction,
      resourceId: entry.pageId,
      metadata: {
        copiedFromPageId: entry.sourcePageId,
        fromSpaceId: input.sourceSpace.id,
        kind: kindBySourceId.get(entry.sourcePageId) ?? 'document',
      },
    })),
  }
}

/**
 * The bytes half of a synchronous copy.
 *
 * It runs **after** the row transaction commits, because `FileService` takes
 * its quota admission on its own connection and a page row still invisible
 * outside this transaction would make that a race. That is why the failure path
 * is compensating: the attachments the copy stored are deleted by
 * `applyTransferCopyAttachments`, and the pages it created are deleted here, so
 * a refused copy — a quota refusal above all — leaves nothing behind.
 */
export const finishTransferCopy = async (
  prisma: PrismaClient,
  fileService: FileService,
  outcome: Extract<TransferOutcome, { kind: 'copy' }>,
): Promise<void> => {
  if (outcome.plan.attachmentWork.length === 0) return
  try {
    await applyTransferCopyAttachments(fileService, prisma, {
      organizationId: outcome.organizationId,
      targetSpace: outcome.targetScope,
      work: outcome.plan.attachmentWork,
      actorUserId: outcome.actorUserId,
      attribution: outcome.attribution,
    })
  } catch (error) {
    await rollbackTransferCopy(prisma, {
      organizationId: outcome.organizationId,
      pageIds: outcome.plan.idMap.map((entry) => entry.pageId),
    }).catch(() => undefined)
    throw error
  }
}
