import type { PrismaClient } from '@prisma/client'
import { withSweepLock, type SweepLockPool } from '@nessie/db'

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
 *
 * `withSweepLock` holds a *session* advisory lock on one connection out of a
 * `pg` pool for as long as the body runs, so the pool is a parameter here
 * rather than the Prisma client these bodies write through. The API already
 * owns one — the realtime hub's — and this shares it instead of opening a
 * third pool on the same URL; each sweep borrows a client for the milliseconds
 * its DELETE takes.
 */
const APPROVAL_SWEEP_LOCK = 'api-maintenance:expired-approvals'
const AGENT_CARD_SWEEP_LOCK = 'api-maintenance:expired-agent-cards'
const REFRESH_CREDENTIAL_SWEEP_LOCK = 'api-maintenance:expired-uoa-session-credentials'
const PUSH_SURFACE_SWEEP_LOCK = 'api-maintenance:stale-push-surface-presence'

const runApprovalSweep = async (
  prisma: PrismaClient,
  lockPool: SweepLockPool,
): Promise<void> => {
  try {
    await withSweepLock(lockPool, APPROVAL_SWEEP_LOCK, () => sweepExpiredApprovals(prisma))
  } catch {
    console.error('[approval-sweep] Failed to sweep expired approvals')
  }
}

export const runRefreshCredentialSweep = async (
  prisma: PrismaClient,
  lockPool: SweepLockPool,
  initial = false,
): Promise<void> => {
  try {
    await withSweepLock(lockPool, REFRESH_CREDENTIAL_SWEEP_LOCK, () =>
      sweepExpiredUoaSessionCredentials(prisma))
  } catch {
    console.error(
      initial
        ? '[refresh-credential-sweep] Initial credential cleanup failed'
        : '[refresh-credential-sweep] Failed to erase expired credentials',
    )
  }
}

const runAgentCardSweep = async (
  prisma: PrismaClient,
  lockPool: SweepLockPool,
): Promise<void> => {
  try {
    await withSweepLock(lockPool, AGENT_CARD_SWEEP_LOCK, () => sweepExpiredAgentCards(prisma))
  } catch {
    console.error('[agent-card-sweep] Failed to expire lapsed cards')
  }
}

const runPushSurfaceSweep = async (
  prisma: PrismaClient,
  lockPool: SweepLockPool,
): Promise<void> => {
  try {
    await withSweepLock(lockPool, PUSH_SURFACE_SWEEP_LOCK, () =>
      sweepStalePushSurfacePresence(prisma))
  } catch {
    console.error('[push-surface-sweep] Failed to remove stale push surfaces')
  }
}

/** Start bounded API housekeeping and return one shutdown callback. */
export const startApiMaintenance = (
  prisma: PrismaClient,
  lockPool: SweepLockPool,
): (() => void) => {
  const approvalInterval = setInterval(() => {
    void runApprovalSweep(prisma, lockPool)
  }, 60_000)
  const agentCardInterval = setInterval(() => {
    void runAgentCardSweep(prisma, lockPool)
  }, 60_000)
  const refreshCredentialInterval = setInterval(() => {
    void runRefreshCredentialSweep(prisma, lockPool)
  }, 5 * 60_000)
  const pushSurfaceInterval = setInterval(() => {
    void runPushSurfaceSweep(prisma, lockPool)
  }, 5 * 60_000)
  return () => {
    clearInterval(agentCardInterval)
    clearInterval(approvalInterval)
    clearInterval(refreshCredentialInterval)
    clearInterval(pushSurfaceInterval)
  }
}
