import type { PrismaClient } from '@prisma/client'
import { withSweepLock } from '@nessie/db'

import { sweepExpiredAgentCards } from './agent-card-sweep.js'
import { sweepExpiredApprovals } from './approvals.js'
import { sweepStalePushSurfacePresence } from './push-surface-presence.js'
import { sweepExpiredUoaSessionCredentials } from './refresh-session-management.js'

/**
 * Horizontal-scaling invariant 2 (docs/standards/horizontal-scaling.md, audit
 * 2.6): these four sweeps had no leader, so every API replica ran all four on
 * its own timer — N redundant DELETEs contending on the same rows every
 * minute. Each body is one indivisible pass rather than a batch of
 * independent rows, so the primitive is `withSweepLock`, and the lock names
 * below are the cluster-wide identity of each sweep: they must stay stable,
 * because renaming one is the same as taking no lock at all during a rolling
 * deploy.
 */
const APPROVAL_SWEEP_LOCK = 'api-maintenance:expired-approvals'
const AGENT_CARD_SWEEP_LOCK = 'api-maintenance:expired-agent-cards'
const REFRESH_CREDENTIAL_SWEEP_LOCK = 'api-maintenance:expired-uoa-session-credentials'
const PUSH_SURFACE_SWEEP_LOCK = 'api-maintenance:stale-push-surface-presence'

const runApprovalSweep = async (prisma: PrismaClient): Promise<void> => {
  try {
    await withSweepLock(prisma, APPROVAL_SWEEP_LOCK, () => sweepExpiredApprovals(prisma))
  } catch {
    console.error('[approval-sweep] Failed to sweep expired approvals')
  }
}

export const runRefreshCredentialSweep = async (
  prisma: PrismaClient,
  initial = false,
): Promise<void> => {
  try {
    await withSweepLock(prisma, REFRESH_CREDENTIAL_SWEEP_LOCK, () =>
      sweepExpiredUoaSessionCredentials(prisma))
  } catch {
    console.error(
      initial
        ? '[refresh-credential-sweep] Initial credential cleanup failed'
        : '[refresh-credential-sweep] Failed to erase expired credentials',
    )
  }
}

const runAgentCardSweep = async (prisma: PrismaClient): Promise<void> => {
  try {
    await withSweepLock(prisma, AGENT_CARD_SWEEP_LOCK, () => sweepExpiredAgentCards(prisma))
  } catch {
    console.error('[agent-card-sweep] Failed to expire lapsed cards')
  }
}

const runPushSurfaceSweep = async (prisma: PrismaClient): Promise<void> => {
  try {
    await withSweepLock(prisma, PUSH_SURFACE_SWEEP_LOCK, () =>
      sweepStalePushSurfacePresence(prisma))
  } catch {
    console.error('[push-surface-sweep] Failed to remove stale push surfaces')
  }
}

/** Start bounded API housekeeping and return one shutdown callback. */
export const startApiMaintenance = (
  prisma: PrismaClient,
): (() => void) => {
  const approvalInterval = setInterval(() => {
    void runApprovalSweep(prisma)
  }, 60_000)
  const agentCardInterval = setInterval(() => {
    void runAgentCardSweep(prisma)
  }, 60_000)
  const refreshCredentialInterval = setInterval(() => {
    void runRefreshCredentialSweep(prisma)
  }, 5 * 60_000)
  const pushSurfaceInterval = setInterval(() => {
    void runPushSurfaceSweep(prisma)
  }, 5 * 60_000)
  return () => {
    clearInterval(agentCardInterval)
    clearInterval(approvalInterval)
    clearInterval(refreshCredentialInterval)
    clearInterval(pushSurfaceInterval)
  }
}
