import { terminateProviderInstance } from './providers.js'
import type { ProviderProvisionResult, ProvisioningContext } from './types.js'

export const cleanupProvisionedInstance = async (
  context: ProvisioningContext,
  provisioned: ProviderProvisionResult,
): Promise<void> => {
  try {
    const termination = await terminateProviderInstance({
      instance: {
        ...context.instance,
        // Inert here: this path calls the provider's terminate directly and
        // never `persistTermination`, so nothing reads it back onto the row.
        errorMessage: null,
        readyAt: provisioned.status === 'ready' ? new Date() : null,
        providerInstanceRef: provisioned.providerInstanceRef,
        terminatedAt: provisioned.status === 'terminated' ? new Date() : null,
      },
    })

    // This path writes no row, so an unverified cleanup has nowhere to be
    // honest except the log: the machine this worker just provisioned could not
    // be reached to be destroyed, and the row belongs to whoever won the race.
    if (termination.outcome !== 'terminated') {
      console.error(
        '[worker.execution] stale provision cleanup could not confirm removal',
        {
          instanceId: context.instance.id,
          providerInstanceRef: provisioned.providerInstanceRef,
        },
      )
    }
  } catch (error) {
    console.error('[worker.execution] stale provision cleanup failed', error)
  }
}
