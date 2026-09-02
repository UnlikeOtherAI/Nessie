import { Prisma, type PrismaClient } from '@prisma/client'

import type { LedgerAttribution } from './ledger.js'

/**
 * Hand-maintained twin of the Prisma `ConnectorType` enum — nothing derives one
 * from the other, so a new member is added to both in the same change.
 */
export type ConnectorType =
  | 'mcp'
  | 'http'
  | 'web_search'
  | 'web_fetch'
  | 'storage'
  | 'push'
  | 'github'
  | 'oauth'
  | 'email'
  | 'other'

export type ConnectorUsage = {
  connectorType: ConnectorType
  connectorId?: string | null
  target?: string | null
  operation?: string | null
  calls?: number
  units?: number | null
  unitType?: string | null
  costAmount?: number | null
  costCurrency?: string | null
  success?: boolean | null
  latencyMs?: number | null
  metadata?: Record<string, unknown> | null
}

export type StorageTransferOperation = 'download' | 'upload'

/** Record one operational event for a non-AI third-party connector call. */
export const recordConnectorUsage = async (
  prisma: PrismaClient,
  input: { attribution: LedgerAttribution; event: ConnectorUsage },
): Promise<void> => {
  const { attribution, event } = input
  await prisma.connectorUsageEvent.create({
    data: {
      organizationId: attribution.organizationId,
      userId: attribution.userId ?? null,
      projectId: attribution.projectId ?? null,
      teamId: attribution.teamId ?? null,
      channelId: attribution.channelId ?? null,
      threadId: attribution.threadId ?? null,
      taskId: attribution.taskId ?? null,
      runId: attribution.runId ?? null,
      agentId: attribution.agentId ?? null,
      actorId: attribution.actorId,
      actorType: attribution.actorType ?? null,
      requestId: attribution.requestId ?? null,
      correlationId: attribution.correlationId ?? null,
      connectorType: event.connectorType,
      connectorId: event.connectorId ?? null,
      target: event.target ?? null,
      operation: event.operation ?? null,
      calls: event.calls ?? 1,
      units: event.units ?? null,
      unitType: event.unitType ?? null,
      costAmount: event.costAmount ?? null,
      costCurrency: event.costCurrency ?? null,
      success: event.success ?? null,
      latencyMs: event.latencyMs ?? null,
      occurredAt: new Date(),
      metadata: (
        attribution.systemComponent
          ? {
              ...(event.metadata ?? {}),
              systemComponent: attribution.systemComponent,
            }
          : event.metadata ?? undefined
      ) as Prisma.InputJsonValue | undefined,
    },
  })
}

export const recordStorageTransferUsage = async (
  prisma: PrismaClient,
  input: {
    attribution: LedgerAttribution
    bytes: number
    metadata?: Record<string, unknown>
    operation: StorageTransferOperation
    success?: boolean
    target?: string
    latencyMs?: number
  },
): Promise<void> => {
  await recordConnectorUsage(prisma, {
    attribution: input.attribution,
    event: {
      connectorType: 'storage',
      target: input.target ?? 'attachment',
      operation: input.operation,
      calls: 1,
      units: input.bytes,
      unitType: 'bytes',
      success: input.success ?? true,
      latencyMs: input.latencyMs ?? null,
      metadata: input.metadata ?? null,
    },
  })
}
