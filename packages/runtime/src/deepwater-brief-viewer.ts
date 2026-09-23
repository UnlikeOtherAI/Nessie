import type { PrismaClient } from '@prisma/client'
import type { ProductIntegrationRunStatus } from '@nessie/schemas'

import type { DeepWaterBriefRun } from './deepwater-brief-run-record.js'
import { viewerSatisfiesBasis, type DisclosureViewer } from './disclosure-predicate.js'
import {
  computeReplyBasis,
  type DisclosureDestinationChain,
} from './disclosure-reply-basis.js'

/**
 * Who may see a DeepWater research run (Water plan amendments N6). One
 * predicate for the list, the detail, the brief, the research card, the
 * artifact downloads and Copy markdown — a second copy would drift, and a drift
 * here discloses what the research was built from.
 *
 * - `inThread`: the viewer can open the origin thread, and satisfies the run's
 *   source basis as that thread would stamp it today (its live chain and live
 *   agent bindings subtracted — never a stored, destination-subtracted basis).
 * - `portable`: the viewer satisfies the full, unsubtracted source basis.
 *
 * The requester sees the run when either holds. Anyone else needs `inThread`,
 * and never sees a person's brief before it is launched. A denied viewer (live
 * entitlement revoked) sees nothing.
 */

/** The origin thread's live destination: its chain and the agents bound to its channel. */
export type DeepWaterOriginDestination = {
  chain: DisclosureDestinationChain
  boundAgentIds: readonly string[]
}

export type DeepWaterRunVisibilityInput = {
  run: Pick<DeepWaterBriefRun, 'requestedByUserId' | 'originKind' | 'status' | 'sourceScopes'>
  viewerUserId: string
  /** `resolveDisclosureViewer` with the request's live entitlements. */
  viewer: DisclosureViewer
  /** The viewer may open the origin thread (the API's `findThreadForUser`). */
  originThreadReachable: boolean
  /** Null when the origin thread or channel no longer exists. */
  originDestination: DeepWaterOriginDestination | null
}

const UNLAUNCHED_STATUSES: ReadonlySet<ProductIntegrationRunStatus> = new Set(['queued', 'drafting'])

export const isDeepWaterRunVisible = (input: DeepWaterRunVisibilityInput): boolean => {
  if (input.viewer.kind === 'denied') return false
  const { run } = input

  const inThread = input.originThreadReachable
    && input.originDestination !== null
    && viewerSatisfiesBasis(
      computeReplyBasis(run.sourceScopes, input.originDestination.chain, input.originDestination.boundAgentIds),
      input.viewer,
    )

  if (run.requestedByUserId !== null && run.requestedByUserId === input.viewerUserId) {
    return inThread || viewerSatisfiesBasis(run.sourceScopes, input.viewer)
  }
  if (run.originKind === 'person' && UNLAUNCHED_STATUSES.has(run.status)) return false
  return inThread
}

/**
 * Load the origin thread's live destination: the channel's chain, and every
 * agent bound to that channel now. Null when the thread (or its channel) is
 * gone, which leaves only the requester's portable reach.
 */
export const loadDeepWaterOriginDestination = async (
  prisma: Pick<PrismaClient, 'thread' | 'agentBinding'>,
  input: { organizationId: string; threadId: string | null },
): Promise<DeepWaterOriginDestination | null> => {
  if (input.threadId === null) return null
  const thread = await prisma.thread.findFirst({
    where: { id: input.threadId, channel: { organizationId: input.organizationId, deletedAt: null } },
    select: {
      channel: { select: { id: true, organizationId: true, projectId: true, teamId: true } },
    },
  })
  if (!thread) return null
  const bindings = await prisma.agentBinding.findMany({
    where: { channelId: thread.channel.id },
    select: { agentId: true },
  })
  return {
    chain: {
      organizationId: thread.channel.organizationId,
      projectId: thread.channel.projectId,
      teamId: thread.channel.teamId,
      channelId: thread.channel.id,
    },
    boundAgentIds: bindings.map((binding) => binding.agentId),
  }
}
