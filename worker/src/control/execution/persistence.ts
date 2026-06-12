import { type PrismaClient } from '@prisma/client'
import { finalizeLease } from './leases.js'
import { mergeMetadata } from './metadata.js'
import { recordExecutionUsage } from './usage-ledger.js'
import { buildWorkflowInstanceOutput, maybeContinueWorkflowForInstance } from './workflow-continuation.js'
import type { ProviderProvisionResult, ProvisioningContext, TerminationContext } from './types.js'

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

    return failedUpdate.count === 1
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
        errorMessage: null,
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
