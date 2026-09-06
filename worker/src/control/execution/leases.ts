import { type Prisma, type PrismaClient } from '@prisma/client'
import { enqueueAbandonedMachineTermination } from './reclaim.js'
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

export const LEASE_EXPIRED_ERROR = 'EXECUTION_LEASE_EXPIRED'

// One pass reclaims at most this many leases. Unbounded, the pass after a
// full-fleet outage past the 5 min TTL loads every abandoned lease in the
// database into memory on *every* worker at once, and each row costs a
// transaction plus a workflow-continuation read — so the sweep that exists to
// stop cloud machines billing is the sweep that stalls the reconcile interval.
// 50 matches the other bounded control sweeps (`gmail-send-sweep`,
// `board-source-webhooks-renew`) and, at the 15 s interval in
// `worker/src/index.ts`, drains 200 leases a minute per replica. Batching is
// safe because the work is claim-based: an expired lease leaves the predicate
// once it is `expired`, so the next pass takes the next batch and nothing is
// skipped. Oldest first, so the machine that has been billing longest is the
// one reclaimed first — which is also why the loop below isolates a failing
// lease: oldest-first plus a bounded batch means a row that always throws is
// always at the front, and one that aborted the pass would hold the entire
// backlog behind it forever.
const EXPIRED_LEASE_SWEEP_BATCH = 50

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
    orderBy: {
      expiresAt: 'asc',
    },
    take: EXPIRED_LEASE_SWEEP_BATCH,
    select: {
      id: true,
      instanceId: true,
      instance: {
        select: {
          organizationId: true,
          providerInstanceRef: true,
          template: {
            select: { provider: true },
          },
        },
      },
    },
  })

  let expiredCount = 0
  let failedCount = 0
  for (const lease of expiredLeases) {
    try {
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

        const abandonedInstance = await tx.executionEnvironmentInstance.updateMany({
          where: {
            id: lease.instanceId,
            status: {
              in: ['pending', 'provisioning'],
            },
          },
          data: {
            errorMessage: LEASE_EXPIRED_ERROR,
            lastHeartbeatAt: now,
            status: 'failed',
          },
        })

        // Only when *this* pass is the one that declared the instance
        // abandoned. Expiring the lease is not enough on its own: one instance
        // can carry more than one non-terminal lease, because
        // `loadProvisioningContext` re-claims an instance that is already
        // `provisioning`, so a retried allocate job mints a second lease while
        // the first is still live. Expiring that first, orphaned lease then
        // reaches a row a *later* attempt has since driven to `ready` — and
        // without this gate the sweep would enqueue a terminate for a machine
        // that is running fine. The `updateMany` above is the authority: it
        // flips only `pending`/`provisioning`, so `count === 1` means this
        // transaction is the one that made the row terminal.
        //
        // Inside the winning claim, so only the sweeper that actually expired
        // the lease enqueues; `enqueueAbandonedMachineTermination` decides
        // whether the reference is reclaimable at all.
        if (abandonedInstance.count === 1) {
          await enqueueAbandonedMachineTermination(tx, {
            instanceId: lease.instanceId,
            organizationId: lease.instance.organizationId,
            provider: lease.instance.template.provider,
            providerInstanceRef: lease.instance.providerInstanceRef,
            reason: 'lease-expired',
          })
        }

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
    } catch (error) {
      // Per lease, never per pass. The batch above is the *oldest* expired
      // leases, and a row that throws deterministically — an `enqueueQueueJob`
      // that keeps failing, a `maybeContinueWorkflowForInstance` that throws on
      // a malformed workflow graph — leaves the predicate unchanged, so the next
      // pass reads the same batch and meets the same row first. Letting that
      // throw out of the loop would mean the sweep never gets past it: no lease
      // behind it is ever reclaimed and the whole fleet keeps billing behind one
      // poisoned row. Isolated, a permanently failing lease costs one slot of
      // the batch per pass and nothing else.
      //
      // It is reported every pass rather than retried in silence: this line, at
      // the 15 s reconcile interval, is what tells an operator which instance is
      // stuck and with what error. Nothing here retires the row — the machine it
      // names may still be billing, so it must stay in the sweep's sights.
      failedCount += 1
      console.error('[worker.execution-leases] expired-lease reclaim failed', {
        error,
        instanceId: lease.instanceId,
        leaseId: lease.id,
        provider: lease.instance.template.provider,
      })
    }
  }

  if (failedCount > 0) {
    console.error(
      `[worker.execution-leases] ${failedCount} of ${expiredLeases.length} expired leases could not be reclaimed this pass and will be retried`,
    )
  }

  return expiredCount
}
