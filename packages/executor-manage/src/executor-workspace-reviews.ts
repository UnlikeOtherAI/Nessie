import type { PrismaClient } from '@prisma/client'
import {
  ExecutorWorkspaceReviewChangeSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { readExecutorCommandResult } from './executor-commands.js'
import { ExecutorError, EXECUTOR_ERROR_CODES } from './executor-errors.js'
import { getExecutorForManagement } from './executor-records.js'

const MAX_REVIEWS = 20

type WorkspaceReview = {
  acknowledgedAt: string
  changes: Array<{ byteCount: number; kind: 'created' | 'modified' | 'deleted'; path: string }>
  commandId: string
  manifestDigest: string
  runId: string
}

const parseReviewResult = (result: Record<string, unknown>): {
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
    const parsed = result ? parseReviewResult(result) : null
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
