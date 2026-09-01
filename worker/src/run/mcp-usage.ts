import type { PrismaClient } from '@prisma/client'
import {
  recordConnectorUsage,
  type LedgerAttribution,
} from '@nessie/runtime'

export const recordMcpConnectorUsage = async (
  prisma: PrismaClient,
  attribution: LedgerAttribution,
  input: {
    connectorId: string
    latencyMs: number
    operation: string
    success: boolean
  },
): Promise<void> => {
  await recordConnectorUsage(prisma, {
    attribution,
    event: {
      connectorType: 'mcp',
      connectorId: input.connectorId,
      target: input.operation,
      operation: input.operation,
      success: input.success,
      latencyMs: input.latencyMs,
    },
  }).catch(() => {
    // Best-effort operational telemetry must not break connector dispatch.
  })
}
