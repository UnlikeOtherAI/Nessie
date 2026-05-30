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
  const profile = await prisma.modelPricingProfile.create({
    data: {
      organizationId,
      provider: input.provider,
      modelPattern: input.modelPattern,
      currency: input.currency ?? 'USD',
      source: input.source as Parameters<typeof prisma.modelPricingProfile.create>[0]['data']['source'],
      inputPerMillion: input.inputPerMillion ?? null,
      outputPerMillion: input.outputPerMillion ?? null,
      cachedInputPerMillion: input.cachedInputPerMillion ?? null,
      cachedOutputPerMillion: input.cachedOutputPerMillion ?? null,
      cacheReadPerMillion: input.cacheReadPerMillion ?? null,
      cacheWritePerMillion: input.cacheWritePerMillion ?? null,
      effectiveFrom: new Date(),
    },
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

const mapPricingProfile = (profile: {
  id: string
  organizationId: string
  provider: string
  modelPattern: string
  currency: string
  source: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedInputPerMillion: number | null
  cachedOutputPerMillion: number | null
  cacheReadPerMillion: number | null
  cacheWritePerMillion: number | null
  effectiveFrom: Date
  effectiveTo: Date | null
}) => ({
  profileId: profile.id,
  organizationId: profile.organizationId,
  provider: profile.provider,
  modelPattern: profile.modelPattern,
  currency: profile.currency,
  source: profile.source,
  inputPerMillion: profile.inputPerMillion,
  outputPerMillion: profile.outputPerMillion,
  cachedInputPerMillion: profile.cachedInputPerMillion,
  cachedOutputPerMillion: profile.cachedOutputPerMillion,
  cacheReadPerMillion: profile.cacheReadPerMillion,
  cacheWritePerMillion: profile.cacheWritePerMillion,
  effectiveFrom: profile.effectiveFrom.toISOString(),
  effectiveTo: profile.effectiveTo?.toISOString() ?? null,
})
