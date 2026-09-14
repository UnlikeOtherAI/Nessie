import type { Prisma, PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import { releaseAgentTodosForTerminalRun } from '@nessie/team-admin'

import { releaseRunCloudBrowsers } from '../browser-cloud/release-hook.js'
import { clearCrashCheckpoint, clearCrashCheckpointForUnheldRun } from './crash-checkpoint.js'
import { clearRunToolEffects } from './tool-effect-ledger.js'
import { clearWorking } from './working-marker.js'

type CleanupMode = 'best-effort' | 'required'

const runCleanup = async (
  mode: CleanupMode,
  label: string,
  runId: string,
  work: () => Promise<void>,
): Promise<void> => {
  try {
    await work()
  } catch (error) {
    if (mode === 'required') throw error
    console.warn(`[worker] could not ${label} for run`, runId, error)
  }
}

/** Shed resumable state only after a run has reached a settled status. */
export const cleanupRunResumeState = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
  input: { executorToken?: string | null; mode: CleanupMode },
): Promise<void> => {
  await runCleanup(input.mode, 'clear crash checkpoint', runId, async () => {
    await (input.executorToken
      ? clearCrashCheckpoint(prisma, runId, input.executorToken)
      : clearCrashCheckpointForUnheldRun(prisma, runId))
  })
  await runCleanup(input.mode, 'clear tool-effect claims', runId, async () => {
    await clearRunToolEffects(prisma, runId)
  })
}

/**
 * Finish the cleanup obligations shared by every terminal run. Completion
 * follow-ups use required mode so a database fault redelivers the durable job;
 * legacy terminal paths retain their post-status best-effort behavior.
 */
export const cleanupTerminalRun = async (
  prisma: PrismaClient,
  runId: string,
  transport: PgRealtimeTransport | null,
  input: { executorToken?: string | null; mode: CleanupMode },
): Promise<void> => {
  await cleanupRunResumeState(prisma, runId, input)
  await runCleanup(input.mode, 'finish terminal cleanup', runId, async () => {
    const run = await prisma.run.findUnique({
      select: { agentId: true, principalUserId: true, threadId: true, triggerMessageId: true },
      where: { id: runId },
    })
    await releaseAgentTodosForTerminalRun(prisma, runId)
    await releaseRunCloudBrowsers(runId)
    if (!run?.triggerMessageId) return
    await clearWorking(prisma, transport, {
      agentId: run.agentId,
      messageId: run.triggerMessageId,
      ...(run.principalUserId ? { onBehalfOfUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })
  })
}
