import { type PrismaClient } from '@prisma/client'
import { finalizeLease } from './leases.js'
import { mergeMetadata } from './metadata.js'
import { deriveProviderInstanceRef } from './providers.js'
import { enqueueAbandonedMachineTermination } from './reclaim.js'
import { recordExecutionUsage } from './usage-ledger.js'
import { buildWorkflowInstanceOutput, maybeContinueWorkflowForInstance } from './workflow-continuation.js'
import type { ProviderProvisionResult, ProvisioningContext, TerminationContext } from './types.js'

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

export const persistProvisionSuccess = async (
  prisma: PrismaClient,
  context: ProvisioningContext,
  provisioned: ProviderProvisionResult,
): Promise<boolean> => {
  const now = new Date()

  return prisma.$transaction(async (tx) => {
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

    if (finalizedLease.count !== 1 || updatedInstance.count !== 1) {
      return false
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
}

export const persistTermination = async (
  prisma: PrismaClient,
  context: TerminationContext,
  terminationMetadata: Record<string, unknown>,
): Promise<Date> => {
  const now = new Date()

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
        // message to keep.
        errorMessage: context.instance.status === 'failed' ? context.instance.errorMessage : null,
        lastHeartbeatAt: now,
        metadata: mergeMetadata(context.instance.metadata, {
          terminationRequestedAt: null,
          ...(terminationMetadata ?? {}),
        }),
        status: 'terminated',
        terminatedAt: now,
      },
    })

    const billableMinutes =
      context.instance.startedAt && now.getTime() > context.instance.startedAt.getTime()
        ? Math.max(1, Math.ceil((now.getTime() - context.instance.startedAt.getTime()) / 60_000))
        : 0

    if (billableMinutes > 0) {
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
