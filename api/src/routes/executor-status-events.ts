import { publishExecutorStatus } from '@nessie/executor-manage'
import type { FastifyBaseLogger } from 'fastify'
import type { RouteDeps } from './types.js'

export const notifyExecutorStatus = async (
  deps: RouteDeps, log: FastifyBaseLogger, executorId: string,
): Promise<void> => {
  try {
    await publishExecutorStatus(deps.prisma, deps.realtimeHub, executorId)
  } catch (error) {
    log.warn({ err: error, executorId }, 'Executor presence notification failed')
  }
}
