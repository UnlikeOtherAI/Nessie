import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, PricingSource } from '@nessie/schemas'

import { emitAuditEvent } from './audit.js'

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
  // At most one active profile per provider/model pattern. Re-pricing closes
  // the previous row and creates a fresh effective period atomically.
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
        source: input.source as Parameters<
          typeof tx.modelPricingProfile.create
        >[0]['data']['source'],
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
