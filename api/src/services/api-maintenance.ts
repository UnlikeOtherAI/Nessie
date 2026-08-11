import type { PrismaClient } from '@prisma/client'

import { sweepExpiredApprovals } from './approvals.js'
import { sweepStalePushSurfacePresence } from './push-surface-presence.js'
import { sweepExpiredUoaSessionCredentials } from './refresh-session-management.js'

const runApprovalSweep = async (prisma: PrismaClient): Promise<void> => {
  try {
    await sweepExpiredApprovals(prisma)
  } catch {
    console.error('[approval-sweep] Failed to sweep expired approvals')
  }
}

export const runRefreshCredentialSweep = async (
  prisma: PrismaClient,
  initial = false,
): Promise<void> => {
  try {
    await sweepExpiredUoaSessionCredentials(prisma)
  } catch {
    console.error(
      initial
        ? '[refresh-credential-sweep] Initial credential cleanup failed'
        : '[refresh-credential-sweep] Failed to erase expired credentials',
    )
  }
}

const runPushSurfaceSweep = async (prisma: PrismaClient): Promise<void> => {
  try {
    await sweepStalePushSurfacePresence(prisma)
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
  const refreshCredentialInterval = setInterval(() => {
    void runRefreshCredentialSweep(prisma)
  }, 5 * 60_000)
  const pushSurfaceInterval = setInterval(() => {
    void runPushSurfaceSweep(prisma)
  }, 5 * 60_000)
  return () => {
    clearInterval(approvalInterval)
    clearInterval(refreshCredentialInterval)
    clearInterval(pushSurfaceInterval)
  }
}
