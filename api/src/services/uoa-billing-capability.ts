import type { PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  UoaBillingCapability,
} from '@nessie/schemas'
import type { BillingCreditsV1 } from '@unlikeotherai/billing-statement-protocol'

import {
  getUoaBillingCredits,
  type BillingFundingPrisma,
} from './uoa-billing-funding.js'
import type { UoaBillingClientDeps } from './uoa-billing-client.js'

type BillingCapabilityPrisma = Pick<
  PrismaClient,
  'productAccountLink' | 'team'
>

export const capabilityFromUoaCredits = (
  credits: BillingCreditsV1,
  tokenVersion: number,
): UoaBillingCapability => {
  const canManageBilling = credits.viewer.role === 'billing_manager'
  return {
    canManageBilling,
    canReadStatement: canManageBilling,
    scope: {
      organisationId: credits.subject.organisation_id,
      teamId: credits.subject.team_id,
      tokenVersion,
      userId: credits.subject.user_id,
    },
  }
}

/**
 * UOA's projection is both the authority decision and the exact subject that
 * owns it. Local organisation roles must not be used for either purpose.
 */
export const getUoaBillingCapability = async (
  prisma: BillingCapabilityPrisma,
  actorContext: AuthorizedActionContext,
  deps?: UoaBillingClientDeps,
): Promise<UoaBillingCapability> => {
  const credits = await getUoaBillingCredits(
    prisma as BillingFundingPrisma,
    actorContext,
    deps,
  )
  const tokenVersion = actorContext.actionContext.uoaIdentity?.tokenVersion
  if (tokenVersion === null || tokenVersion === undefined) {
    throw new Error('Billing credits resolved without a UOA credential epoch')
  }
  return capabilityFromUoaCredits(credits, tokenVersion)
}
