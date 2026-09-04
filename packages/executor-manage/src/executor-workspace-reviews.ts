import type { PrismaClient } from '@prisma/client'
import {
  ExecutorWorkspaceReviewChangeSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { readExecutorCommandResult } from './executor-command-results.js'
import { ExecutorError, EXECUTOR_ERROR_CODES } from './executor-errors.js'
import { getExecutorForManagement } from './executor-records.js'

const MAX_REVIEWS = 20

export type WorkspaceReview = {
  acknowledgedAt: string
  changes: Array<{ byteCount: number; kind: 'created' | 'modified' | 'deleted'; path: string }>
  commandId: string
  manifestDigest: string
  runId: string
}

export type OriginatingWorkspaceReview = WorkspaceReview & { executorId: string }

export const parseExecutorWorkspaceReviewResult = (result: Record<string, unknown>): {
  changes: WorkspaceReview['changes']
  manifestDigest: string
} | null => {
  if (result.success !== true || typeof result.manifestDigest !== 'string' || !Array.isArray(result.changes)) {
    return null
  }
  const changes = ExecutorWorkspaceReviewChangeSchema.array().max(100).safeParse(result.changes)
  if (!changes.success || typeof result.changeCount !== 'number' || result.changeCount !== changes.data.length) {
    return null
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(result.manifestDigest)) return null
  return { changes: changes.data, manifestDigest: result.manifestDigest }
}

/**
 * A manager can inspect bounded review receipts, never raw draft contents.
 * Ordinary users receive their review through the originating task; exposing
 * all project/org runs here would turn an executor management screen into a
 * cross-run data feed.
 */
export const listExecutorWorkspaceReviews = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<WorkspaceReview[]> => {
  const executor = await getExecutorForManagement(prisma, actorContext, executorId)
  if (!executor) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor not found.')
  }
  const commands = await prisma.executorCommand.findMany({
    where: {
      binding: { executorId, operationKey: 'workspace.review' },
      state: 'result_acknowledged',
    },
    orderBy: { acknowledgedAt: 'desc' },
    select: {
      acknowledgedAt: true,
      id: true,
      binding: { select: { runId: true } },
    },
    take: MAX_REVIEWS,
  })
  const reviews = await Promise.all(commands.map(async (command) => {
    const result = await readExecutorCommandResult(prisma, encryptionSecret, command.id)
    const parsed = result ? parseExecutorWorkspaceReviewResult(result) : null
    if (!parsed || !command.acknowledgedAt) return null
    return {
      acknowledgedAt: command.acknowledgedAt.toISOString(),
      changes: parsed.changes,
      commandId: command.id,
      manifestDigest: parsed.manifestDigest,
      runId: command.binding.runId,
    } satisfies WorkspaceReview
  }))
  return reviews.filter((review): review is WorkspaceReview => review !== null)
}

/** A user sees only reviews from runs they themselves started, across their entitled executors. */
export const listOriginatingExecutorWorkspaceReviews = async (
  prisma: PrismaClient,
  encryptionSecret: string,
  actorContext: AuthorizedActionContext,
): Promise<OriginatingWorkspaceReview[]> => {
  if (actorContext.actor.actorType !== 'user') return []
  const commands = await prisma.executorCommand.findMany({
    where: {
      binding: {
        operationKey: 'workspace.review',
        run: {
          triggerMessage: { userId: actorContext.actor.actorId },
          thread: { channel: { organizationId: actorContext.tenant.organizationId } },
        },
      },
      state: 'result_acknowledged',
    },
    orderBy: { acknowledgedAt: 'desc' },
    select: {
      acknowledgedAt: true,
      binding: { select: { executorId: true, runId: true } },
      id: true,
    },
    take: MAX_REVIEWS,
  })
  const reviews = await Promise.all(commands.map(async (command) => {
    const result = await readExecutorCommandResult(prisma, encryptionSecret, command.id)
    const parsed = result ? parseExecutorWorkspaceReviewResult(result) : null
    if (!parsed || !command.acknowledgedAt) return null
    return {
      acknowledgedAt: command.acknowledgedAt.toISOString(),
      changes: parsed.changes,
      commandId: command.id,
      executorId: command.binding.executorId,
      manifestDigest: parsed.manifestDigest,
      runId: command.binding.runId,
    } satisfies OriginatingWorkspaceReview
  }))
  return reviews.filter((review): review is OriginatingWorkspaceReview => review !== null)
}
