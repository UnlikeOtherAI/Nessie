import { type Prisma, type PrismaClient } from '@prisma/client'
import {
  buildWorkflowInstanceOutput,
  loadWorkflowInstanceState,
  maybeContinueWorkflowForInstance,
} from './workflow-continuation.js'
import type { ExecutionProvider } from './types.js'

export const DEFAULT_LEASE_TTL_MS = 5 * 60_000
export const DEFAULT_RUNNER_STALE_MS = 90_000
// An hour is two orders of magnitude past the 30 s heartbeat, so a row this
// old belongs to a process that is gone rather than to one that is slow.
export const RUNNER_RETENTION_MS = 60 * 60_000

export const selectRunner = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    provider: ExecutionProvider
    runnerLabelPrefix: string
  },
) =>
  tx.executionRunner.findFirst({
    where: {
      provider: input.provider,
      status: 'active',
      label: `${input.runnerLabelPrefix}-${input.provider}`,
      heartbeatAt: {
        gt: new Date(Date.now() - DEFAULT_RUNNER_STALE_MS),
      },
      OR: [{ organizationId: input.organizationId }, { organizationId: null }],
    },
    orderBy: [{ organizationId: 'desc' }, { updatedAt: 'desc' }],
  })

export const acknowledgeLease = async (
  prisma: PrismaClient,
  leaseId: string,
): Promise<boolean> => {
  const now = new Date()
  const updated = await prisma.executionLease.updateMany({
    where: {
      id: leaseId,
      status: 'issued',
      expiresAt: {
        gt: now,
      },
    },
    data: {
      status: 'acknowledged',
      acknowledgedAt: now,
      expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
    },
  })

  return updated.count === 1
}

export const renewExecutionLeases = async (
  prisma: PrismaClient,
  input: {
    runnerLabelPrefix: string
  },
): Promise<number> => {
  const now = new Date()
  const runnerIds = await prisma.executionRunner.findMany({
    where: {
      label: {
        in: ['docker', 'gcloud'].map((provider) => `${input.runnerLabelPrefix}-${provider}`),
      },
      status: 'active',
      heartbeatAt: {
        gt: new Date(now.getTime() - DEFAULT_RUNNER_STALE_MS),
      },
    },
    select: { id: true },
  })
  if (runnerIds.length === 0) {
    return 0
  }

  const updated = await prisma.executionLease.updateMany({
    where: {
      runnerId: {
        in: runnerIds.map((runner) => runner.id),
      },
      status: 'acknowledged',
    },
    data: {
      expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS),
    },
  })

  return updated.count
}

// Every worker process now registers its own `execution_runners` rows (one per
// provider, keyed by a per-boot label), so without a reaper the table grows two
// rows per restart forever. Deleting is only safe while the runner holds no
// non-terminal lease: `execution_leases.runner_id` is a cascading FK, so a
// delete would take a live lease with it. `expireExecutionLeases` runs first in
// the same sweep, which is what turns an abandoned lease terminal in time for
// the next pass to collect its runner.
export const reapStaleExecutionRunners = async (
  prisma: PrismaClient,
): Promise<number> => {
  const deleted = await prisma.executionRunner.deleteMany({
    where: {
      heartbeatAt: {
        lt: new Date(Date.now() - RUNNER_RETENTION_MS),
      },
      leases: {
        none: {
          status: {
            in: ['issued', 'acknowledged'],
          },
        },
      },
    },
  })

  return deleted.count
}

export const finalizeLease = async (
  tx: Prisma.TransactionClient,
  input: {
    leaseId: string
    status: 'completed' | 'expired' | 'revoked'
  },
): Promise<void> => {
  await tx.executionLease.updateMany({
    where: {
      id: input.leaseId,
      status: {
        in: ['issued', 'acknowledged'],
      },
    },
    data: {
      status: input.status,
      completedAt: new Date(),
    },
  })
}

export const expireExecutionLeases = async (
  prisma: PrismaClient,
): Promise<number> => {
  const now = new Date()
  const expiredLeases = await prisma.executionLease.findMany({
    where: {
      expiresAt: {
        lt: now,
      },
      status: {
        in: ['issued', 'acknowledged'],
      },
    },
    select: {
      id: true,
      instanceId: true,
    },
  })

  let expiredCount = 0
  for (const lease of expiredLeases) {
    const result = await prisma.$transaction(async (tx) => {
      const updatedLease = await tx.executionLease.updateMany({
        where: {
          expiresAt: {
            lt: now,
          },
          id: lease.id,
          status: {
            in: ['issued', 'acknowledged'],
          },
        },
        data: {
          completedAt: now,
          status: 'expired',
        },
      })
      if (updatedLease.count === 0) {
        return false
      }

      await tx.executionEnvironmentInstance.updateMany({
        where: {
          id: lease.instanceId,
          status: {
            in: ['pending', 'provisioning'],
          },
        },
        data: {
          errorMessage: 'EXECUTION_LEASE_EXPIRED',
          lastHeartbeatAt: now,
          status: 'failed',
        },
      })

      return true
    })

    if (result) {
      const terminalInstance = await loadWorkflowInstanceState(prisma, lease.instanceId)
      if (terminalInstance?.status === 'failed') {
        await maybeContinueWorkflowForInstance(prisma, {
          instance: terminalInstance,
          output: buildWorkflowInstanceOutput({
            errorMessage: terminalInstance.errorMessage,
            instanceId: terminalInstance.id,
            metadata: terminalInstance.metadata,
            providerInstanceRef: terminalInstance.providerInstanceRef,
            status: terminalInstance.status,
          }),
          success: false,
          summary: terminalInstance.errorMessage ?? 'Execution environment lease expired.',
        })
      }
      expiredCount += 1
    }
  }

  return expiredCount
}
