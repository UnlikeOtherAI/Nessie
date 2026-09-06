import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'

import type { LedgerAttribution } from './ledger.js'

/**
 * Whether a connector event's `costAmount` belongs in a local cost aggregate.
 *
 * `operational_only` means the call is metered somewhere else and Nessie holds
 * only its operational telemetry — calls, units, latency. Deep Water is the
 * standing case (`docs/standards/deepwater.md`): UOA is the sole commercial
 * authority, its events carry no cost fields at all, and a database trigger
 * rejects any attempt to give them one.
 */
export const ConnectorUsageMeteringSchema = z.enum(['billable', 'operational_only'])
export type ConnectorUsageMetering = z.infer<typeof ConnectorUsageMeteringSchema>

/**
 * The shape of `ConnectorUsageEvent.metadata`.
 *
 * Two keys are governed because a *money* question is decided on them, and
 * they were previously decided by whichever spelling a writer happened to
 * pick — the cost report carried a four-way OR over `productSlug`,
 * `product_slug`, `product` and `source` because each new writer's spelling was
 * appended to the read side instead of the write side being fixed. Everything
 * else a connector wants to record about its own call (an attachment id, an
 * email classification, a source label) passes through untouched: it is
 * provenance, and nothing aggregates on it.
 */
export const ConnectorUsageMetadataSchema = z.object({
  metering: ConnectorUsageMeteringSchema.default('billable'),
  /** The integrated product this call belongs to, where it belongs to one. */
  productSlug: z.string().min(1).optional(),
}).passthrough()
export type ConnectorUsageMetadata = z.infer<typeof ConnectorUsageMetadataSchema>

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

/**
 * Record one operational event for a non-AI third-party connector call.
 *
 * This is the write door for the metadata contract above: every event that
 * reaches the table through here carries an explicit `metering`, so the cost
 * report reads one field rather than guessing at spellings.
 */
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
      metadata: ConnectorUsageMetadataSchema.parse({
        ...(event.metadata ?? {}),
        ...(attribution.systemComponent
          ? { systemComponent: attribution.systemComponent }
          : {}),
      }) as Prisma.InputJsonValue,
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
