import { parseOrganizationId } from '@nessie/schemas'
import { publishExecutorStatus } from '@nessie/executor-manage'
import type { FastifyBaseLogger } from 'fastify'
import type { RouteDeps } from './types.js'

export const notifyExecutorStatus = async (
  deps: RouteDeps, log: FastifyBaseLogger, executorId: string, inventoryOrganizationId?: string,
): Promise<void> => {
  try {
    await publishExecutorStatus(deps.prisma, deps.realtimeHub, executorId)
    if (inventoryOrganizationId) {
      // No machine identity: this also reaches a person whose access was removed.
      await deps.realtimeHub.publishWs([{
        kind: 'executor_inventory', organizationId: parseOrganizationId(inventoryOrganizationId),
      }], { event: 'executor.inventory.changed', data: {} })
    }
  } catch (error) {
    log.warn({ err: error, executorId }, 'Executor presence notification failed')
  }
}
