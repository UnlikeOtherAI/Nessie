import type { PrismaClient } from '@prisma/client'
import { readDeepWaterTeamConnector } from '@nessie/mcp-manage'
import {
  activeTeamMatchesAttribution,
  loadUoaProductIdentity,
  type LedgerIdentityService,
} from '@nessie/runtime'
import {
  DeepWaterRequesterIdentitySchema,
  isAdminActor,
  type AuthorizedActionContext,
  type DeepWaterRequesterIdentity,
  type DeepWaterResearchReadiness,
  type DeepWaterResearchReadinessState,
} from '@nessie/schemas'

import { DEEP_WATER_PRODUCT_SLUG, NESSIE_LEDGER_APP_API_KEY_ENV } from './deepwater-activation.js'

/**
 * Can this person start DeepWater research in this team right now, and if not,
 * which remedy applies (Water plan nessie.md §7.1 "Readiness")? One answer for
 * every research doorway — the composer button, Knowledge › Research, the app
 * page — and the same answer the brief API gives when it refuses with
 * `DEEP_WATER_NOT_READY`. The Personal Assistant's grants are not an input: a
 * person's brief never goes through an agent.
 */

/**
 * The person's live UOA identity, as a brief captures it: their linked
 * DeepWater account, on the login epoch this session carries, with UOA's
 * active organisation and team matching this Nessie team. Null means they must
 * sign in (again) before DeepWater can act for them. Stable UOA ids only.
 */
export const resolveDeepWaterRequesterIdentity = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  teamId: string,
): Promise<DeepWaterRequesterIdentity | null> => {
  const uoaIdentity = actorContext.actionContext.uoaIdentity
  if (!uoaIdentity) return null
  const attribution = {
    organizationId: actorContext.tenant.organizationId,
    teamId,
    userId: actorContext.actor.actorId,
    actorId: actorContext.actor.actorId,
    actorType: 'user' as const,
    uoaIdentity,
  }
  const linked = await loadUoaProductIdentity(prisma, attribution, DEEP_WATER_PRODUCT_SLUG)
  if (!linked || !await activeTeamMatchesAttribution(prisma, attribution, linked)) return null
  const parsed = DeepWaterRequesterIdentitySchema.safeParse(linked)
  return parsed.success ? parsed.data : null
}

/**
 * Nessie can reach Ledger for DeepWater at all: its product-bound app key is
 * configured, and so is its signed caller identity — the Ledger identity
 * service the API builds from the same environment (null when it is not).
 */
export const isLedgerConfiguredForDeepWater = (ledgerIdentity: LedgerIdentityService | null): boolean =>
  Boolean(process.env[NESSIE_LEDGER_APP_API_KEY_ENV]?.trim()) && ledgerIdentity !== null

/** Readiness, with the identity a brief would capture when it is ready. */
export type DeepWaterResearchAccess =
  | { state: 'ready'; identity: DeepWaterRequesterIdentity }
  | { state: Exclude<DeepWaterResearchReadinessState, 'ready'>; identity: null }

/**
 * The one order every doorway and the brief API decide readiness in: the
 * team's switch and connector, then Nessie's own Ledger configuration, then
 * the person's identity — so a person is always told the remedy that comes
 * first, whichever surface they ask from.
 */
export const resolveDeepWaterResearchAccess = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { teamId: string; ledgerIdentity: LedgerIdentityService | null },
): Promise<DeepWaterResearchAccess> => {
  const connector = await readDeepWaterTeamConnector(prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId: input.teamId,
  })
  if (connector.state !== 'ready') return { state: connector.state, identity: null }
  if (!isLedgerConfiguredForDeepWater(input.ledgerIdentity)) return { state: 'unavailable', identity: null }
  const identity = await resolveDeepWaterRequesterIdentity(prisma, actorContext, input.teamId)
  return identity ? { state: 'ready', identity } : { state: 'account_not_linked', identity: null }
}

export const resolveDeepWaterResearchReadiness = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { teamId: string; ledgerIdentity: LedgerIdentityService | null },
): Promise<DeepWaterResearchReadiness> => ({
  state: (await resolveDeepWaterResearchAccess(prisma, actorContext, input)).state,
  // The cancel standing (amendments N8.5): an organisation owner or admin may
  // cancel any open research in their team, exactly as the cancel route checks
  // it (`resolveDeepWaterResearchViewer`). Turning DeepWater on, off or
  // updating it is owner-only, so a client gates those on the session's owner
  // role, never on this.
  viewerCanChangeTeam: isAdminActor(actorContext),
})
