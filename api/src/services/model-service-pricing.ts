import { Prisma, type PrismaClient } from '@prisma/client'
import type { ModelConfig } from '@nessie/config'
import { recomputeTokenLedgerCosts, type LedgerIdentityService } from '@nessie/runtime'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  ledgerAgentModelCatalogRequestHeaders,
  listLedgerModelServicePrices,
  type LedgerModelServicePrice,
} from '@nessie/team-admin'

import { lockModelPricing } from './pricing-profiles.js'

/**
 * The model service's published prices, kept as this organisation's default
 * estimate (`provider-default` pricing profiles), so an estimated cost is
 * never $0.00 just because nobody typed a rate in (plan §10.12).
 *
 * An owner's own price always wins (`findActivePricingProfile`), and a model
 * the owner has priced exactly is left alone here: the active-row index allows
 * one price per model pattern, and theirs is the one that stands. When they
 * delete it, the next refresh restores the published price.
 */

export type ModelServicePricingDeps = {
  config: Pick<ModelConfig, 'apiKey' | 'baseUrl'>
  ledgerIdentity: LedgerIdentityService | null
  ledgerPublicUrl?: string
  fetchImpl?: Parameters<typeof listLedgerModelServicePrices>[0]['fetchImpl']
  prisma: PrismaClient
}

export type ModelServicePricingSyncResult = {
  /** Models the model service publishes a usable token price for. */
  publishedModels: number
  added: number
  updated: number
  /** Published models left alone because the owner priced them. */
  ownerPriced: number
  /** Past usage that had no estimate and now has one. */
  repricedEvents: number
}

// Rates are stored as NUMERIC(20, 8). A published rate is rounded to that
// precision before it is compared or written, or a rate with more digits would
// never match what was stored and every refresh would replace it.
const storedPrecision = (rate: number | null): number | null =>
  rate === null ? null : Math.round(rate * 1e8) / 1e8

const sameRate = (stored: Prisma.Decimal | null, published: number | null): boolean =>
  stored === null ? published === null : published !== null && stored.toNumber() === published

/**
 * Write the published prices as the organisation's `provider-default`
 * profiles: add the new, replace the changed, leave the unchanged and the
 * owner-priced. Serialised with the owner's own writes on one advisory lock.
 */
export const writeModelServicePrices = async (
  prisma: PrismaClient,
  organizationId: string,
  prices: readonly LedgerModelServicePrice[],
  now: Date = new Date(),
): Promise<Omit<ModelServicePricingSyncResult, 'repricedEvents'>> =>
  prisma.$transaction(async (tx) => {
    await lockModelPricing(tx, organizationId)
    const active = await tx.modelPricingProfile.findMany({
      where: { effectiveTo: null, organizationId },
      select: {
        cacheReadPerMillion: true,
        cachedInputPerMillion: true,
        id: true,
        inputPerMillion: true,
        modelPattern: true,
        outputPerMillion: true,
        provider: true,
        source: true,
      },
    })
    const activeByPattern = new Map(active.map((row) => [`${row.provider}\u0000${row.modelPattern}`, row]))
    const result = { added: 0, ownerPriced: 0, publishedModels: prices.length, updated: 0 }

    for (const published of prices) {
      const price = {
        ...published,
        cachedInputPerMillion: storedPrecision(published.cachedInputPerMillion),
        inputPerMillion: storedPrecision(published.inputPerMillion),
        outputPerMillion: storedPrecision(published.outputPerMillion),
      }
      const existing = activeByPattern.get(`${price.provider}\u0000${price.model}`)
      if (existing && existing.source !== 'provider_default') {
        result.ownerPriced += 1
        continue
      }
      if (
        existing
        && sameRate(existing.inputPerMillion, price.inputPerMillion)
        && sameRate(existing.outputPerMillion, price.outputPerMillion)
        && sameRate(existing.cachedInputPerMillion, price.cachedInputPerMillion)
      ) {
        continue
      }
      if (existing) {
        await tx.modelPricingProfile.update({ where: { id: existing.id }, data: { effectiveTo: now } })
        result.updated += 1
      } else {
        result.added += 1
      }
      await tx.modelPricingProfile.create({
        data: {
          // A published cached-input price is the price of reused input, which
          // the ledger records as either cached-input or cache-read tokens.
          cacheReadPerMillion: price.cachedInputPerMillion,
          cachedInputPerMillion: price.cachedInputPerMillion,
          currency: 'USD',
          effectiveFrom: now,
          inputPerMillion: price.inputPerMillion,
          modelPattern: price.model,
          organizationId,
          outputPerMillion: price.outputPerMillion,
          provider: price.provider,
          source: 'provider_default',
        },
      })
    }
    return result
  })

/** Read the published prices as the acting owner, write them, value past usage. */
export const syncModelServicePricing = async (
  deps: ModelServicePricingDeps,
  actorContext: AuthorizedActionContext,
): Promise<ModelServicePricingSyncResult> => {
  const organizationId = actorContext.tenant.organizationId
  const prices = await listLedgerModelServicePrices({
    config: deps.config,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.ledgerPublicUrl ? { ledgerPublicUrl: deps.ledgerPublicUrl } : {}),
    requestHeaders: await ledgerAgentModelCatalogRequestHeaders({
      actorContext,
      ledgerIdentity: deps.ledgerIdentity,
    }),
  })
  const written = await writeModelServicePrices(deps.prisma, organizationId, prices)
  const repriced = await recomputeTokenLedgerCosts(deps.prisma, organizationId)
  return { ...written, repricedEvents: repriced.updatedEvents }
}

// Recent enough to be about models in use, short enough to stay a cheap read.
const RECENT_UNPRICED_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

/**
 * Whether reading usage should first refresh the published prices: the
 * organisation has none yet, or recent usage it paid for has no price at all —
 * neither the owner's nor a published one — which is a model the last refresh
 * did not know about.
 */
export const modelServicePricingNeeded = async (
  prisma: PrismaClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<boolean> => {
  const published = await prisma.modelPricingProfile.count({
    where: { effectiveTo: null, organizationId, source: 'provider_default' },
  })
  if (published === 0) return true
  const since = new Date(now.getTime() - RECENT_UNPRICED_WINDOW_MS)
  const unpriced = await prisma.$queryRaw<Array<{ found: number }>>(Prisma.sql`
    SELECT 1 AS found
    FROM token_ledger_events e
    WHERE e.organization_id = ${organizationId}::uuid
      AND e.billing_source = 'ledger'
      AND e.estimated_cost_amount IS NULL
      AND e.occurred_at >= ${since}
      AND NOT EXISTS (
        SELECT 1 FROM model_pricing_profiles p
        WHERE p.organization_id = e.organization_id
          AND p.provider = e.provider
          AND p.model_pattern IN (e.model, '*')
          AND (p.effective_to IS NULL OR p.effective_to > ${now})
      )
    LIMIT 1
  `)
  return unpriced.length > 0
}

/**
 * The refresh an owner's usage read runs first when it is needed. Never fails
 * the read: without the model service the page still shows what is known,
 * and says how much has no price.
 */
export const ensureModelServicePricing = async (
  deps: ModelServicePricingDeps,
  actorContext: AuthorizedActionContext,
): Promise<void> => {
  try {
    if (await modelServicePricingNeeded(deps.prisma, actorContext.tenant.organizationId)) {
      await syncModelServicePricing(deps, actorContext)
    }
  } catch (error) {
    console.warn('[pricing] could not refresh the model service prices', {
      error: error instanceof Error ? error.message : String(error),
      organizationId: actorContext.tenant.organizationId,
    })
  }
}
