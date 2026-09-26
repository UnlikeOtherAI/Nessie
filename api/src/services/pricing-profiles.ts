import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, PricingSource } from '@nessie/schemas'

import { emitAuditEvent } from './audit.js'

/**
 * An owner's price and the model service's published price are two writers of
 * one table, and a partial unique index allows one active row per
 * (organisation, provider, model pattern). Both take this lock first, so an
 * owner saving a price while the published prices are refreshed never races
 * into that index.
 */
export const lockModelPricing = (
  tx: Pick<PrismaClient, '$queryRaw'>,
  organizationId: string,
): Prisma.PrismaPromise<unknown> => tx.$queryRaw(Prisma.sql`
  SELECT 1
  FROM (
    SELECT pg_advisory_xact_lock(hashtextextended(${`model-pricing:${organizationId}`}, 0))
  ) AS acquired
`)

/** A pricing write refused for a reason the owner can act on. */
export class PricingProfileError extends Error {
  constructor(
    readonly code: 'PRICING_PROFILE_NOT_FOUND' | 'PRICING_PROFILE_PUBLISHED' | 'PRICING_SOURCE_RESERVED',
    readonly httpStatus: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'PricingProfileError'
  }
}

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
  // The model service's prices are written by `syncModelServicePricing` alone;
  // an owner's row marked as one would rank below every other owner price and
  // be replaced by the next refresh.
  if (input.source === 'provider-default') {
    throw new PricingProfileError(
      'PRICING_SOURCE_RESERVED',
      400,
      'Published prices come from the model service. Save your own price instead.',
    )
  }
  // At most one active profile per provider/model pattern. Re-pricing closes
  // the previous row and creates a fresh effective period atomically. An
  // owner's price for a model the model service also prices replaces that
  // published row; the refresh leaves the model alone while the owner's stands.
  const profile = await prisma.$transaction(async (tx) => {
    await lockModelPricing(tx, organizationId)
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
  const profile = await prisma.modelPricingProfile.findFirst({
    where: { effectiveTo: null, id: profileId, organizationId },
    select: { source: true },
  })
  if (!profile) {
    throw new PricingProfileError('PRICING_PROFILE_NOT_FOUND', 404, 'That price no longer exists.')
  }
  // Deleting a published price would only bring it back with the next refresh;
  // what an owner means is "use my price", which is saving one.
  if (profile.source === 'provider_default') {
    throw new PricingProfileError(
      'PRICING_PROFILE_PUBLISHED',
      409,
      'This price is published by the model service. Save your own price for the model to replace it.',
    )
  }
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
