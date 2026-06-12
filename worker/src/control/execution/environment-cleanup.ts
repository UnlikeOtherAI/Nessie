import { terminateProviderInstance } from './providers.js'
import type { ProviderProvisionResult, ProvisioningContext } from './types.js'

export const cleanupProvisionedInstance = async (
  context: ProvisioningContext,
  provisioned: ProviderProvisionResult,
): Promise<void> => {
  try {
    await terminateProviderInstance({
      instance: {
        ...context.instance,
        readyAt: provisioned.status === 'ready' ? new Date() : null,
        providerInstanceRef: provisioned.providerInstanceRef,
        terminatedAt: provisioned.status === 'terminated' ? new Date() : null,
      },
    })
  } catch (error) {
    console.error('[worker.execution] stale provision cleanup failed', error)
  }
}
