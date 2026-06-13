import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, PricingSource } from '@nessie/schemas'
import { emitAuditEvent } from './audit.js'

export const getTokenUsageSummary = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    projectId?: string
    teamId?: string
    channelId?: string
    runId?: string
    agentId?: string
    actorId?: string
    provider?: string
    model?: string
    from?: string
    to?: string
    groupBy?: string
  },
) => {
  const conditions: string[] = ['"organization_id" = $1::uuid']
  const params: unknown[] = [organizationId]
  let paramIdx = 2

  if (filters?.projectId) {
    conditions.push(`"project_id" = $${paramIdx++}::uuid`)
    params.push(filters.projectId)
  }
  if (filters?.teamId) {
    conditions.push(`"team_id" = $${paramIdx++}::uuid`)
    params.push(filters.teamId)
  }
  if (filters?.channelId) {
    conditions.push(`"channel_id" = $${paramIdx++}::uuid`)
    params.push(filters.channelId)
  }
  if (filters?.runId) {
    conditions.push(`"run_id" = $${paramIdx++}::uuid`)
    params.push(filters.runId)
  }
  if (filters?.agentId) {
    conditions.push(`"agent_id" = $${paramIdx++}::uuid`)
    params.push(filters.agentId)
  }
  if (filters?.actorId) {
    conditions.push(`"actor_id" = $${paramIdx++}`)
    params.push(filters.actorId)
  }
  if (filters?.provider) {
    conditions.push(`"provider" = $${paramIdx++}`)
    params.push(filters.provider)
  }
  if (filters?.model) {
    conditions.push(`"model" = $${paramIdx++}`)
    params.push(filters.model)
  }
  if (filters?.from) {
    conditions.push(`"occurred_at" >= $${paramIdx++}`)
    params.push(new Date(filters.from))
  }
  if (filters?.to) {
    conditions.push(`"occurred_at" <= $${paramIdx++}`)
    params.push(new Date(filters.to))
  }

  const whereClause = conditions.join(' AND ')
  const groupByColumn = filters?.groupBy
    ? {
        provider: '"provider"',
        model: '"model"',
        runId: '"run_id"',
        channelId: '"channel_id"',
        agentId: '"agent_id"',
        actorId: '"actor_id"',
        operationType: '"operation_type"',
      }[filters.groupBy] ?? '"provider"'
    : null

  // Totals
  const totals = await prisma.$queryRawUnsafe<
    Array<{
      total_input: bigint
      total_output: bigint
      total_tokens: bigint
      total_estimated: number
      total_provider: number
    }>
  >(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input,
       COALESCE(SUM(output_tokens), 0) as total_output,
       COALESCE(SUM(total_tokens), 0) as total_tokens,
       COALESCE(SUM(estimated_cost_amount), 0) as total_estimated,
       COALESCE(SUM(provider_cost_amount), 0) as total_provider
     FROM token_ledger_events
     WHERE ${whereClause}`,
    ...params,
  )

  const row = totals[0]

  // Breakdowns
  const breakdowns: Array<{
    key: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    estimatedCost: number
    providerReportedCost: number
  }> = []

  if (groupByColumn) {
    const grouped = await prisma.$queryRawUnsafe<
      Array<{
        key: string
        input_tokens: bigint
        output_tokens: bigint
        total_tokens: bigint
        estimated_cost: number
        provider_cost: number
      }>
    >(
      `SELECT
         ${groupByColumn} as key,
         COALESCE(SUM(input_tokens), 0) as input_tokens,
         COALESCE(SUM(output_tokens), 0) as output_tokens,
         COALESCE(SUM(total_tokens), 0) as total_tokens,
         COALESCE(SUM(estimated_cost_amount), 0) as estimated_cost,
         COALESCE(SUM(provider_cost_amount), 0) as provider_cost
       FROM token_ledger_events
       WHERE ${whereClause}
       GROUP BY ${groupByColumn}
       ORDER BY total_tokens DESC`,
      ...params,
    )

    for (const g of grouped) {
      breakdowns.push({
        key: g.key ?? 'unknown',
        inputTokens: Number(g.input_tokens),
        outputTokens: Number(g.output_tokens),
        totalTokens: Number(g.total_tokens),
        estimatedCost: Number(g.estimated_cost),
        providerReportedCost: Number(g.provider_cost),
      })
    }
  }

  return {
    totalInputTokens: Number(row?.total_input ?? 0),
    totalOutputTokens: Number(row?.total_output ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
    totalEstimatedCost: Number(row?.total_estimated ?? 0),
    totalProviderReportedCost: Number(row?.total_provider ?? 0),
    currency: 'USD',
    breakdowns,
  }
}

export const getConnectorUsageSummary = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    connectorType?: string
    agentId?: string
    channelId?: string
    connectorId?: string
    from?: string
    to?: string
    groupBy?: string | null
  },
) => {
  const conditions: string[] = ['"organization_id" = $1::uuid']
  const params: unknown[] = [organizationId]
  let paramIdx = 2

  if (filters?.connectorType) {
    conditions.push(`"connector_type" = $${paramIdx++}`)
    params.push(filters.connectorType)
  }
  if (filters?.agentId) {
    conditions.push(`"agent_id" = $${paramIdx++}::uuid`)
    params.push(filters.agentId)
  }
  if (filters?.channelId) {
    conditions.push(`"channel_id" = $${paramIdx++}::uuid`)
    params.push(filters.channelId)
  }
  if (filters?.connectorId) {
    conditions.push(`"connector_id" = $${paramIdx++}::uuid`)
    params.push(filters.connectorId)
  }
  if (filters?.from) {
    conditions.push(`"occurred_at" >= $${paramIdx++}`)
    params.push(new Date(filters.from))
  }
  if (filters?.to) {
    conditions.push(`"occurred_at" <= $${paramIdx++}`)
    params.push(new Date(filters.to))
  }

  const whereClause = conditions.join(' AND ')
  const groupByColumn = filters?.groupBy
    ? {
        connectorType: '"connector_type"',
        agentId: '"agent_id"',
        channelId: '"channel_id"',
        connectorId: '"connector_id"',
        operation: '"operation"',
      }[filters.groupBy] ?? '"connector_type"'
    : null

  const totals = await prisma.$queryRawUnsafe<
    Array<{
      total_calls: bigint
      total_units: bigint
      total_cost: number
    }>
  >(
    `SELECT
       COALESCE(SUM(calls), 0) as total_calls,
       COALESCE(SUM(units), 0) as total_units,
       COALESCE(SUM(cost_amount), 0) as total_cost
     FROM connector_usage_events
     WHERE ${whereClause}`,
    ...params,
  )

  const row = totals[0]
  const breakdowns: Array<{
    key: string
    calls: number
    units: number
    cost: number
  }> = []

  if (groupByColumn) {
    const grouped = await prisma.$queryRawUnsafe<
      Array<{
        key: string
        calls: bigint
        units: bigint
        cost: number
      }>
    >(
      `SELECT
         ${groupByColumn} as key,
         COALESCE(SUM(calls), 0) as calls,
         COALESCE(SUM(units), 0) as units,
         COALESCE(SUM(cost_amount), 0) as cost
       FROM connector_usage_events
       WHERE ${whereClause}
       GROUP BY ${groupByColumn}
       ORDER BY calls DESC`,
      ...params,
    )

    for (const g of grouped) {
      breakdowns.push({
        key: g.key ?? 'unknown',
        calls: Number(g.calls),
        units: Number(g.units),
        cost: Number(g.cost),
      })
    }
  }

  return {
    totalCalls: Number(row?.total_calls ?? 0),
    totalUnits: Number(row?.total_units ?? 0),
    totalCost: Number(row?.total_cost ?? 0),
    currency: 'USD',
    breakdowns,
  }
}

export const getFileUsageSummary = async (
  prisma: PrismaClient,
  organizationId: string,
  filters?: {
    from?: string
    to?: string
  },
) => {
  const transferWhere: Prisma.ConnectorUsageEventWhereInput = {
    organizationId,
    connectorType: 'storage',
    unitType: 'bytes',
  }
  const occurredAt: Prisma.DateTimeFilter = {}
  if (filters?.from) {
    occurredAt.gte = new Date(filters.from)
  }
  if (filters?.to) {
    occurredAt.lte = new Date(filters.to)
  }
  if (Object.keys(occurredAt).length > 0) {
    transferWhere.occurredAt = occurredAt
  }

  const [stored, transferTotals, transferBreakdowns] = await Promise.all([
    prisma.attachment.aggregate({
      where: { organizationId },
      _count: { id: true },
      _sum: { sizeBytes: true },
    }),
    prisma.connectorUsageEvent.aggregate({
      where: transferWhere,
      _count: { id: true },
      _sum: { units: true },
    }),
    prisma.connectorUsageEvent.groupBy({
      by: ['operation'],
      where: transferWhere,
      _count: { id: true },
      _sum: { units: true },
    }),
  ])

  const breakdowns = transferBreakdowns
    .map((row) => ({
      key: row.operation ?? 'unknown',
      bytes: Number(row._sum.units ?? 0),
      events: row._count.id,
    }))
    .sort((left, right) => right.bytes - left.bytes)

  return {
    currentStoredBytes: Number(stored._sum.sizeBytes ?? 0),
    currentAttachmentCount: stored._count.id,
    totalTransferBytes: Number(transferTotals._sum.units ?? 0),
    totalTransferEvents: transferTotals._count.id,
    uploadBytes: breakdowns
      .filter((row) => row.key === 'upload')
      .reduce((sum, row) => sum + row.bytes, 0),
    downloadBytes: breakdowns
      .filter((row) => row.key === 'download')
      .reduce((sum, row) => sum + row.bytes, 0),
    breakdowns,
  }
}

export const getMonthlyEstimate = async (
  prisma: PrismaClient,
  organizationId: string,
) => {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const daysElapsed = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86400000))
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate()

  const summary = await getTokenUsageSummary(prisma, organizationId, {
    from: monthStart.toISOString(),
    to: now.toISOString(),
  })

  const dailyRate = summary.totalEstimatedCost / daysElapsed
  const projectedMonthlyCost = dailyRate * daysInMonth

  return {
    currentMonthUsage: summary.totalTokens,
    currentMonthCost: summary.totalEstimatedCost,
    projectedMonthlyCost,
    currency: 'USD',
    daysElapsed,
    daysInMonth,
  }
}

// ─── Pricing Profiles ───────────────────────────────────────────────────────

export const listPricingProfiles = async (
  prisma: PrismaClient,
  organizationId: string,
) => {
  const profiles = await prisma.modelPricingProfile.findMany({
    where: {
      organizationId,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  return profiles.map(mapPricingProfile)
}

export const createPricingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    provider: string
    modelPattern: string
    currency?: string
    source: PricingSource
    inputPerMillion?: number
    outputPerMillion?: number
    cachedInputPerMillion?: number
    cachedOutputPerMillion?: number
    cacheReadPerMillion?: number
    cacheWritePerMillion?: number
  },
  actorContext: AuthorizedActionContext,
) => {
  // At most one ACTIVE profile per (org, provider, modelPattern) — enforced by a
  // partial unique index. Re-pricing a model supersedes the current active row
  // instead of erroring, so the editor is a simple "set the price".
  const profile = await prisma.$transaction(async (tx) => {
    await tx.modelPricingProfile.updateMany({
      where: {
        organizationId,
        provider: input.provider,
        modelPattern: input.modelPattern,
        effectiveTo: null,
      },
      data: { effectiveTo: new Date() },
    })
    return tx.modelPricingProfile.create({
      data: {
        organizationId,
        provider: input.provider,
        modelPattern: input.modelPattern,
        currency: input.currency ?? 'USD',
        source: input.source as Parameters<typeof tx.modelPricingProfile.create>[0]['data']['source'],
        inputPerMillion: input.inputPerMillion ?? null,
        outputPerMillion: input.outputPerMillion ?? null,
        cachedInputPerMillion: input.cachedInputPerMillion ?? null,
        cachedOutputPerMillion: input.cachedOutputPerMillion ?? null,
        cacheReadPerMillion: input.cacheReadPerMillion ?? null,
        cacheWritePerMillion: input.cacheWritePerMillion ?? null,
        effectiveFrom: new Date(),
      },
    })
  })

  await emitAuditEvent(prisma, {
    actorContext,
    action: 'pricing.created',
    resourceType: 'pricing',
    resourceId: profile.id,
    outcome: 'success',
    metadata: { provider: input.provider, modelPattern: input.modelPattern },
  })

  return mapPricingProfile(profile)
}

export const deletePricingProfile = async (
  prisma: PrismaClient,
  profileId: string,
  organizationId: string,
  actorContext: AuthorizedActionContext,
) => {
  await prisma.modelPricingProfile.update({
    where: { id: profileId, organizationId },
    data: { effectiveTo: new Date() },
  })

  await emitAuditEvent(prisma, {
    actorContext,
    action: 'pricing.deleted',
    resourceType: 'pricing',
    resourceId: profileId,
    outcome: 'success',
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Per-million rates are stored as NUMERIC (Prisma Decimal); collapse them to
// number so the JSON contract stays `number | null`.
const decimalToNumber = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber()

const mapPricingProfile = (profile: {
  id: string
  organizationId: string
  provider: string
  modelPattern: string
  currency: string
  source: string
  inputPerMillion: Prisma.Decimal | null
  outputPerMillion: Prisma.Decimal | null
  cachedInputPerMillion: Prisma.Decimal | null
  cachedOutputPerMillion: Prisma.Decimal | null
  cacheReadPerMillion: Prisma.Decimal | null
  cacheWritePerMillion: Prisma.Decimal | null
  effectiveFrom: Date
  effectiveTo: Date | null
}) => ({
  profileId: profile.id,
  organizationId: profile.organizationId,
  provider: profile.provider,
  modelPattern: profile.modelPattern,
  currency: profile.currency,
  source: profile.source,
  inputPerMillion: decimalToNumber(profile.inputPerMillion),
  outputPerMillion: decimalToNumber(profile.outputPerMillion),
  cachedInputPerMillion: decimalToNumber(profile.cachedInputPerMillion),
  cachedOutputPerMillion: decimalToNumber(profile.cachedOutputPerMillion),
  cacheReadPerMillion: decimalToNumber(profile.cacheReadPerMillion),
  cacheWritePerMillion: decimalToNumber(profile.cacheWritePerMillion),
  effectiveFrom: profile.effectiveFrom.toISOString(),
  effectiveTo: profile.effectiveTo?.toISOString() ?? null,
})
