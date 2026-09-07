import { type PrismaClient } from '@prisma/client'
import { finalizeLease } from './leases.js'
import { mergeMetadata } from './metadata.js'
import { INSTANCE_ID_LABEL } from './naming.js'
import { deriveProviderInstanceRef } from './providers.js'
import { enqueueAbandonedMachineTermination } from './reclaim.js'
import { asObject, parseString } from './stored-json.js'
import { recordExecutionUsage } from './usage-ledger.js'
import { buildWorkflowInstanceOutput, maybeContinueWorkflowForInstance } from './workflow-continuation.js'
import type {
  ProviderProvisionResult,
  ProviderTerminationResult,
  ProvisioningContext,
  TerminationContext,
} from './types.js'

// Record the intent before the side effect.
//
// `persistProvisionSuccess` below is the only other writer of
// `provider_instance_ref`, and it commits in the same transaction that finishes
// the lease — so between `provisionProviderInstance` creating a real VM and
// that transaction landing, a killed worker used to leave a machine running
// with nothing in the database naming it. `expireExecutionLeases` detects
// exactly that abandonment, but it can only enqueue a terminate for an instance
// that carries a reference, so the one crash the sweep exists to catch was the
// one crash it could never act on. Writing the derived reference first is what
// closes that window.
//
// The window this opens instead is safe: the row briefly names a machine that
// may never be created. A terminate for one reaches `terminateGcloud`, which
// swallows a `not found` from `gcloud … delete` as already-gone, so the sweep
// still ends at an honest `terminated` row rather than an error.
//
// Gated on `pending`/`provisioning` like every other write in this path, so a
// concurrent termination that already moved the row off provisioning is not
// overwritten. `persistProvisionSuccess` later writes the identical string.
export const persistDerivedProviderInstanceRef = async (
  prisma: PrismaClient,
  context: ProvisioningContext,
): Promise<void> => {
  const providerInstanceRef = deriveProviderInstanceRef(context)
  if (!providerInstanceRef) {
    return
  }

  await prisma.executionEnvironmentInstance.updateMany({
    where: {
      id: context.instance.id,
      status: {
        in: ['pending', 'provisioning'],
      },
    },
    data: {
      providerInstanceRef,
    },
  })
}

// A provider that throws has not necessarily created nothing. `provisionGcloud`
// runs two commands for a Cloud Run job — `deploy` then `execute` — so a throw
// from the second leaves a deployed job behind; a VM create can return an error
// after the instance exists. This path used to mark the instance `failed` and
// stop: the lease was finalized in the same transaction, so the sweep would
// never see it, and the machine ran forever with a terminal row naming it.
//
// It could not have done better before, because the row carried no reference
// until a provision succeeded. Now that `persistDerivedProviderInstanceRef` has
// written the address the provider was about to use, the failure path can reap
// what it may have created — through the same terminate the lease sweep
// enqueues, not a second mechanism, so both go through one host-independence
// rule and one idempotency key. The terminate is harmless when the machine was
// never created: `terminateGcloud` swallows a `not found` from
// `gcloud … delete` as already-gone.
export const markProvisionFailure = async (
  prisma: PrismaClient,
  context: ProvisioningContext,
  error: unknown,
): Promise<boolean> => {
  const now = new Date()
  const message = error instanceof Error ? error.message : 'Execution environment provisioning failed'

  const updated = await prisma.$transaction(async (tx) => {
    await finalizeLease(tx, {
      leaseId: context.leaseId,
      status: 'completed',
    })

    // Read the row, not `context.instance`: the reference was written after the
    // context was loaded, by `persistDerivedProviderInstanceRef`.
    const current = await tx.executionEnvironmentInstance.findUnique({
      where: { id: context.instance.id },
      select: { providerInstanceRef: true },
    })

    const failedUpdate = await tx.executionEnvironmentInstance.updateMany({
      where: {
        id: context.instance.id,
        status: {
          in: ['pending', 'provisioning'],
        },
      },
      data: {
        errorMessage: message,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(context.instance.metadata, {
          leaseFailedAt: now.toISOString(),
          leaseId: context.leaseId,
          runnerId: context.runnerId,
        }),
        status: 'failed',
      },
    })

    if (failedUpdate.count !== 1) {
      return false
    }

    // Gated on this transaction being the one that made the row terminal, for
    // the same reason the sweep is: a row someone else has driven to `ready`
    // names a machine that is running fine, and must not be reclaimed.
    await enqueueAbandonedMachineTermination(tx, {
      instanceId: context.instance.id,
      organizationId: context.instance.organizationId,
      provider: context.instance.template.provider,
      providerInstanceRef: current?.providerInstanceRef ?? null,
      reason: 'provision-failed',
    })

    return true
  })

  if (updated) {
    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        errorMessage: message,
        instanceId: context.instance.id,
        metadata: context.instance.metadata,
        status: 'failed',
      }),
      success: false,
      summary: message,
    })
  }

  return updated
}

// Rolls the transaction back and never leaves this module. A Prisma interactive
// transaction commits unless the callback throws, so returning `false` from
// inside one — which is what this path used to do when either conditional write
// matched no rows — committed whatever the other write had already done and then
// reported failure. The worst shape of that: the lease was already revoked by a
// concurrent terminate, the instance write still matched, and the row was
// committed `ready`, pointing at the machine the caller was about to destroy in
// `cleanupProvisionedInstance` — with no allocation usage recorded and nothing
// left to move it off `ready`.
//
// Throwing is the only way to roll back, and this class is what keeps that throw
// from changing the function's contract: it is caught at the transaction
// boundary below and turned back into `false`, so the caller keeps distinguishing
// "nothing was persisted, clean up the machine" (false) from "something went
// wrong" (a real error, which still propagates to `markProvisionFailure`). If
// this escaped instead, `allocateExecutionEnvironmentInstance`'s catch would run
// `markProvisionFailure` and skip the cleanup, leaking the machine.
class ProvisionPersistConflict extends Error {
  override readonly name = 'ProvisionPersistConflict'
}

export const persistProvisionSuccess = async (
  prisma: PrismaClient,
  context: ProvisioningContext,
  provisioned: ProviderProvisionResult,
): Promise<boolean> => {
  const now = new Date()

  try {
    return await prisma.$transaction(async (tx) => {
      const finalizedLease = await tx.executionLease.updateMany({
        where: {
          id: context.leaseId,
          status: 'acknowledged',
        },
        data: {
          completedAt: now,
          status: 'completed',
        },
      })

      const updatedInstance = await tx.executionEnvironmentInstance.updateMany({
        where: {
          id: context.instance.id,
          status: {
            in: ['pending', 'provisioning'],
          },
        },
        data: {
          errorMessage: null,
          lastHeartbeatAt: now,
          metadata: mergeMetadata(context.instance.metadata, {
            leaseId: context.leaseId,
            runnerId: context.runnerId,
            ...(provisioned.metadata ?? {}),
          }),
          providerInstanceRef: provisioned.providerInstanceRef,
          readyAt: provisioned.status === 'ready' ? now : null,
          status: provisioned.status,
          terminatedAt: provisioned.status === 'terminated' ? now : null,
        },
      })

      // Not a return: the two writes above are already in this transaction, and
      // returning here would commit them. Throwing rolls both back, so a
      // provision that could not be recorded leaves the row exactly as the
      // concurrent writer left it.
      if (finalizedLease.count !== 1 || updatedInstance.count !== 1) {
        throw new ProvisionPersistConflict(
          `EXECUTION_PROVISION_PERSIST_CONFLICT:${context.instance.id}`,
        )
      }

      await recordExecutionUsage(tx, {
        actorId: context.instance.launchedByActorId,
        actorType: context.instance.launchedByActorType,
        agentId: context.instance.agentId,
        channelId: context.instance.channelId,
        instanceId: context.instance.id,
        metadata: {
          provider: context.instance.template.provider,
          runnerId: context.runnerId,
          ...(provisioned.metadata ?? {}),
        },
        meterType: 'allocation',
        organizationId: context.instance.organizationId,
        projectId: context.instance.projectId,
        quantity: 1,
        runId: context.instance.runId,
        teamId: context.instance.teamId,
        templateId: context.instance.template.id,
        templatePricingConfig: context.instance.template.pricingConfig,
        workflowRunId: context.instance.workflowRunId,
        workflowStepRunId: context.instance.workflowStepRunId,
      })

      return true
    })
  } catch (error) {
    // The rollback signal, converted back into the contract the caller reads:
    // `false` means nothing was persisted and the machine just provisioned is the
    // caller's to clean up. Every other error still propagates, so a genuine
    // database failure reaches `markProvisionFailure` as it always did.
    if (error instanceof ProvisionPersistConflict) {
      return false
    }
    throw error
  }
}

// The error code an operator queries for. A terminate that could not prove the
// container is gone leaves the instance `failed` carrying this — a state on the
// row, reachable through `GET /api/execution-environment-instances` like any
// other failure — rather than a `terminated` row and a sentence in a log nobody
// reads. `provider_instance_ref` stays on the row, because the container id and
// the `nessie.instance-id` label built from it are how the machine is found on
// the host that provisioned it.
export const TERMINATION_UNVERIFIED_ERROR = 'EXECUTION_TERMINATE_UNVERIFIED'

export const buildUnverifiedTerminationMessage = (context: TerminationContext): string => {
  const runnerLabel = parseString(asObject(context.instance.metadata)['runnerLabel'])

  return `${TERMINATION_UNVERIFIED_ERROR}:${context.instance.providerInstanceRef ?? 'unknown'}`
    + ` — this worker's ${context.instance.template.provider} daemon does not have that`
    + ' container, so it was not removed and may still be running on'
    + ` ${runnerLabel ? `runner ${runnerLabel}` : 'the runner that provisioned it'}.`
    + ` Find it there by its \`${INSTANCE_ID_LABEL}=${context.instance.id}\` label and`
    + ' remove it on that host.'
}

export const persistTermination = async (
  prisma: PrismaClient,
  context: TerminationContext,
  termination: ProviderTerminationResult,
): Promise<Date> => {
  const now = new Date()
  // Only a provider that reached the resource may move the row to `terminated`.
  // `unverified` keeps a terminal row an operator can act on — `failed` with the
  // reason — instead of recording a removal nobody performed (plan row 5.12).
  const verified = termination.outcome === 'terminated'
  const terminationMetadata = termination.metadata
  // An unverified terminate leaves the row non-terminal, so it can be asked to
  // terminate again. The uptime meter is recorded by the pass that ends this
  // instance's tracking, never by every pass that tries: `billableMinutes` runs
  // from `startedAt` to now, so a second attempt would bill the whole uptime a
  // second time. It also keeps the original failure reason from being replaced
  // by an earlier unverified message.
  const alreadyUnverified = Boolean(
    asObject(context.instance.metadata)['terminationUnverifiedAt'],
  )

  await prisma.$transaction(async (tx) => {
    await tx.executionLease.updateMany({
      where: {
        instanceId: context.instance.id,
        status: {
          in: ['issued', 'acknowledged'],
        },
      },
      data: {
        completedAt: now,
        status: 'revoked',
      },
    })

    await tx.executionEnvironmentInstance.update({
      where: { id: context.instance.id },
      data: {
        // Terminating a machine does not un-fail the instance. Both reclaim
        // paths — the lease sweep and `markProvisionFailure` — mark the row
        // `failed` with why, then enqueue this terminate; clearing the message
        // here would leave an operator with a `terminated` row and no record of
        // what went wrong. A normal termination of a healthy instance has no
        // message to keep. An unverified terminate writes its own reason, and
        // keeps whatever the row said before it under `errorBeforeTermination`.
        errorMessage: verified
          ? (context.instance.status === 'failed' ? context.instance.errorMessage : null)
          : buildUnverifiedTerminationMessage(context),
        lastHeartbeatAt: now,
        metadata: mergeMetadata(context.instance.metadata, {
          terminationRequestedAt: null,
          ...(verified
            ? {}
            : {
              terminationUnverifiedAt: now.toISOString(),
              ...(context.instance.errorMessage && !alreadyUnverified
                ? { errorBeforeTermination: context.instance.errorMessage }
                : {}),
            }),
          ...(terminationMetadata ?? {}),
        }),
        status: verified ? 'terminated' : 'failed',
        terminatedAt: verified ? now : context.instance.terminatedAt,
      },
    })

    const billableMinutes =
      context.instance.startedAt && now.getTime() > context.instance.startedAt.getTime()
        ? Math.max(1, Math.ceil((now.getTime() - context.instance.startedAt.getTime()) / 60_000))
        : 0

    if (billableMinutes > 0 && !alreadyUnverified) {
      await recordExecutionUsage(tx, {
        actorId: context.instance.launchedByActorId,
        actorType: context.instance.launchedByActorType,
        agentId: context.instance.agentId,
        channelId: context.instance.channelId,
        instanceId: context.instance.id,
        metadata: {
          terminatedAt: now.toISOString(),
          ...(terminationMetadata ?? {}),
        },
        meterType: 'uptime_min',
        organizationId: context.instance.organizationId,
        projectId: context.instance.projectId,
        quantity: billableMinutes,
        runId: context.instance.runId,
        teamId: context.instance.teamId,
        templateId: context.instance.template.id,
        templatePricingConfig: context.instance.template.pricingConfig,
        workflowRunId: context.instance.workflowRunId,
        workflowStepRunId: context.instance.workflowStepRunId,
      })
    }
  })

  return now
}
