import { type AuditActorType, type Prisma } from '@prisma/client'
import { asObject, parseNonNegativeNumber } from './stored-json.js'

const computeUsageCost = (input: {
  pricingConfig: unknown
  quantity: number
}): { costAmount?: number; currency?: string; unitPrice?: number } => {
  const pricing = asObject(input.pricingConfig)
  const unitPrice = parseNonNegativeNumber(pricing['unitPrice'])
  const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : undefined

  if (unitPrice === null) {
    return { currency }
  }

  return {
    unitPrice,
    costAmount: Number((unitPrice * input.quantity).toFixed(6)),
    currency,
  }
}

export const recordExecutionUsage = async (
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    actorType: string
    agentId: string | null
    channelId: string | null
    instanceId: string
    metadata?: Record<string, unknown>
    meterType: string
    organizationId: string
    projectId: string | null
    quantity: number
    runId: string | null
    teamId: string | null
    templateId: string
    templatePricingConfig: unknown
    workflowRunId: string | null
    workflowStepRunId: string | null
  },
): Promise<void> => {
  const pricing = computeUsageCost({
    pricingConfig: input.templatePricingConfig,
    quantity: input.quantity,
  })

  await tx.executionUsageLedger.create({
    data: {
      actorId: input.actorId,
      actorType: input.actorType as AuditActorType,
      agentId: input.agentId,
      channelId: input.channelId,
      costAmount: pricing.costAmount,
      currency: pricing.currency,
      instanceId: input.instanceId,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      meterType: input.meterType,
      organizationId: input.organizationId,
      projectId: input.projectId,
      quantity: input.quantity,
      runId: input.runId,
      teamId: input.teamId,
      templateId: input.templateId,
      unitPrice: pricing.unitPrice,
      workflowRunId: input.workflowRunId,
      workflowStepRunId: input.workflowStepRunId,
    },
  })
}
