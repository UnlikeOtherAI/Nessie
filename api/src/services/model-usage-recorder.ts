import type { PrismaClient } from '@prisma/client'
import type { LedgerAttribution, LedgerInvocation } from '@nessie/runtime'
import { recordInferenceUsage } from '@nessie/runtime'

type WarningLogger = {
  warn: (bindings: unknown, message: string) => void
}

/**
 * Persist metered model calls without letting a local accounting failure block
 * the request that generated them.
 */
export const recordModelUsage = async (
  prisma: PrismaClient,
  logger: WarningLogger,
  invocations: LedgerInvocation[],
  attribution: LedgerAttribution,
): Promise<void> => {
  try {
    await recordInferenceUsage(prisma, { attribution, invocations })
  } catch (err) {
    logger.warn({ err }, 'ledger: token usage write failed')
  }
}
