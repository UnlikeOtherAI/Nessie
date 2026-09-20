import {
  resolveDisclosureViewer,
  resolveLiveEntitlementDecision,
  viewerSatisfiesBasis,
  type DisclosureViewer,
} from '@nessie/runtime'

import type { ExecutionDependencies, RunContext } from './types.js'

type RecipientAuthorizationInput = {
  ownerUserId: string | null | undefined
  context: Pick<RunContext, 'consumedSources'>
  viewer: DisclosureViewer
}

/**
 * A host is a prompt recipient, not merely a route for its agent's output.
 * Keep this source-basis and exact-author check separate from reply disclosure:
 * no destination-implied scope is subtracted for a computer.
 */
export const localInferenceRecipientIsAuthorized = (
  input: RecipientAuthorizationInput,
): boolean => Boolean(
  input.ownerUserId
  && viewerSatisfiesBasis(input.context.consumedSources.list(), input.viewer)
  && input.context.consumedSources.privateConversationSources().every(
    (source) => source.sourceAuthorUserId === input.ownerUserId,
  ),
)

/**
 * Resolve the custodian's entitlement afresh for every provider call. The
 * stored identity path still validates the UOA subject and epoch; a timeout or
 * denial is not a stale allow for local prompt delivery.
 */
export const authorizeLocalInferenceRecipient = async (
  deps: ExecutionDependencies,
  context: RunContext,
): Promise<boolean> => {
  const ownerUserId = context.agent.ownerUserId
  if (!ownerUserId) return false
  const decision = await resolveLiveEntitlementDecision(deps.prisma, {
    allowStoredIdentity: true,
    organizationId: context.channel.organizationId,
    userId: ownerUserId,
  })
  if (decision.status !== 'allowed') return false
  const viewer = await resolveDisclosureViewer(
    deps.prisma,
    context.channel.organizationId,
    ownerUserId,
    { allowStoredUoaIdentity: true, liveEntitlements: decision.entitlements },
  )
  return localInferenceRecipientIsAuthorized({ context, ownerUserId, viewer })
}
