import { type PrismaClient } from '@prisma/client'
import { loadProvisioningContext, loadTerminationContext } from './execution/claims.js'
import { cleanupProvisionedInstance } from './execution/environment-cleanup.js'
import { acknowledgeLease } from './execution/leases.js'
import {
  markProvisionFailure,
  persistDerivedProviderInstanceRef,
  persistProvisionSuccess,
  persistTermination,
} from './execution/persistence.js'
import { provisionProviderInstance, terminateProviderInstance } from './execution/providers.js'
import { asObject } from './execution/stored-json.js'
import {
  buildWorkflowInstanceOutput,
  loadWorkflowInstanceState,
  maybeContinueWorkflowForInstance,
} from './execution/workflow-continuation.js'

export { buildGcloudRunJobArgs } from './execution/gcloud-provider.js'
export {
  expireExecutionLeases,
  reapStaleExecutionRunners,
  renewExecutionLeases,
} from './execution/leases.js'
export { registerExecutionRunners } from './execution/runners.js'

export const allocateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  input: {
    instanceId: string
    runnerLabelPrefix?: string
  },
): Promise<boolean> => {
  const context = await loadProvisioningContext(
    prisma,
    input.instanceId,
    input.runnerLabelPrefix ?? `${process.env.HOSTNAME ?? 'local-worker'}`,
  )
  if (!context) {
    const terminalInstance = await loadWorkflowInstanceState(prisma, input.instanceId)
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
        summary: terminalInstance.errorMessage ?? 'Execution environment allocation failed.',
      })
    }
    return false
  }

  const acknowledged = await acknowledgeLease(prisma, context.leaseId)
  if (!acknowledged) {
    await markProvisionFailure(prisma, context, new Error('EXECUTION_LEASE_NOT_ACKNOWLEDGED'))
    return false
  }

  try {
    // Before the machine exists, not after: a crash between the provider
    // returning and `persistProvisionSuccess` committing would otherwise leave
    // a VM running that nothing in the database names, and the lease sweep only
    // reclaims what the instance row points at. Providers whose reference is
    // only knowable after the fact (docker) derive nothing and this is a no-op.
    await persistDerivedProviderInstanceRef(prisma, context)

    const provisioned = await provisionProviderInstance(context)
    const persisted = await persistProvisionSuccess(prisma, context, provisioned)

    if (!persisted) {
      await cleanupProvisionedInstance(context, provisioned)
      const terminalInstance = await loadWorkflowInstanceState(prisma, context.instance.id)
      if (terminalInstance && ['failed', 'terminated'].includes(terminalInstance.status)) {
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
          summary:
            terminalInstance.errorMessage
            ?? (terminalInstance.status === 'terminated'
              ? 'Execution environment terminated before activation completed.'
              : 'Execution environment activation did not complete.'),
        })
      }
      return false
    }

    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        instanceId: context.instance.id,
        metadata: {
          runnerId: context.runnerId,
          ...(provisioned.metadata ?? {}),
        },
        providerInstanceRef: provisioned.providerInstanceRef,
        status: provisioned.status,
      }),
      success: true,
      summary:
        provisioned.status === 'terminated'
          ? 'Execution environment completed and terminated.'
          : 'Execution environment is ready.',
    })

    return true
  } catch (error) {
    await markProvisionFailure(prisma, context, error)
    return false
  }
}

export const terminateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<boolean> => {
  const context = await loadTerminationContext(prisma, instanceId)
  if (!context) {
    return false
  }
  if (context.instance.status === 'terminated') {
    await maybeContinueWorkflowForInstance(prisma, {
      instance: context.instance,
      output: buildWorkflowInstanceOutput({
        instanceId: context.instance.id,
        metadata: context.instance.metadata,
        providerInstanceRef: context.instance.providerInstanceRef,
        status: context.instance.status,
      }),
      success: false,
      summary: 'Execution environment was terminated.',
    })
    return true
  }

  const terminationMetadata = await terminateProviderInstance(context)
  await persistTermination(prisma, context, terminationMetadata)

  await maybeContinueWorkflowForInstance(prisma, {
    instance: context.instance,
    output: buildWorkflowInstanceOutput({
      instanceId: context.instance.id,
      metadata: {
        ...asObject(context.instance.metadata),
        terminationRequestedAt: null,
        ...(terminationMetadata ?? {}),
      },
      providerInstanceRef: context.instance.providerInstanceRef,
      status: 'terminated',
    }),
    success: false,
    summary: 'Execution environment was terminated.',
  })

  return true
}
