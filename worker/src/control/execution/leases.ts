import { randomUUID } from 'node:crypto'
import { type Prisma, type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '../../queue.js'
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

// A lease that reaches expiry belongs to a runner that stopped renewing, so the
// machine it provisioned has nobody left pointing at it. Which of them the
// sweep can actually reclaim depends on whether the provider reference is
// addressable from any worker.
//
// `gcloud` refs are `gcloud:<kind>:<project>:<zone|region>:<name>` — a global
// address. Whichever replica claims `execution.environment.terminate` deletes
// the real VM or Cloud Run job, so the sweep enqueues one.
//
// `docker` refs are a container id on ONE host's daemon (horizontal-scaling
// audit 8.2; `docs/standards/horizontal-scaling.md` invariant 7). Queue jobs
// are not host-routed, so a terminate claimed by another replica would run
// `docker rm -f` against the wrong daemon, get `No such container`, have
// `terminateDocker` swallow it as already-gone, and let `persistTermination`
// write `terminated` — a lie about a container that is still running and still
// consuming the dead host's CPU. The sweep therefore never enqueues one.
// Instead the instance keeps the honest terminal state it already has,
// `failed`, and its error message names the container so an operator (or the
// host's own restart) can reap it. `loadProvisioningContext` makes the mirror
// refusal on the way in with `EXECUTION_RUNNER_NOT_LOCAL`.
const HOST_INDEPENDENT_PROVIDERS: readonly ExecutionProvider[] = ['gcloud']

export const ABANDONED_HOST_LOCAL_INSTANCE_ERROR = 'EXECUTION_INSTANCE_ABANDONED_HOST_LOCAL'

// The terminate the sweep asks for is the sweep's own act, not a replay of
// whoever launched the instance: attributing it to the launcher would put a
// request in the audit trail that person never made, and `launchedByActorType`
// can be `system`, which `AuthorizedActionContextSchema` does not accept.
const buildLeaseSweepActorContext = (input: {
  instanceId: string
  organizationId: string
}) => ({
  actionContext: {
    correlationId: `execution-lease-expiry:${input.instanceId}`,
    purpose: 'execution.lease.expiry',
    requestId: randomUUID(),
  },
  actor: {
    actorId: 'execution-lease-sweep',
    actorType: 'service' as const,
    roles: ['system'],
  },
  tenant: {
    organizationId: input.organizationId,
  },
})

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
// one reclaimed first.
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
  for (const lease of expiredLeases) {
    const providerInstanceRef = lease.instance.providerInstanceRef
    const provider = lease.instance.template.provider
    const abandonedHostLocal =
      Boolean(providerInstanceRef) && !HOST_INDEPENDENT_PROVIDERS.includes(provider)

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
          errorMessage: abandonedHostLocal
            ? `${ABANDONED_HOST_LOCAL_INSTANCE_ERROR}:${provider}:${providerInstanceRef}`
            : LEASE_EXPIRED_ERROR,
          lastHeartbeatAt: now,
          status: 'failed',
        },
      })

      // Inside the winning claim, so only the sweeper that actually expired the
      // lease enqueues. The idempotency key repeats the guarantee across sweep
      // passes, and is namespaced apart from the API's
      // `execution-environment:terminate:<id>` so a user-requested termination
      // that already ran cannot suppress this one.
      if (providerInstanceRef && !abandonedHostLocal) {
        await enqueueQueueJob(tx, {
          idempotencyKey: `execution-environment:terminate:lease-expired:${lease.instanceId}`,
          payload: {
            actorContext: buildLeaseSweepActorContext({
              instanceId: lease.instanceId,
              organizationId: lease.instance.organizationId,
            }),
            instanceId: lease.instanceId,
          },
          topic: 'execution.environment.terminate',
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
  }

  return expiredCount
}
