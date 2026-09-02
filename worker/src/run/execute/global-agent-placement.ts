import { getGlobalAgentBlueprint, globalAgentHomePrefix } from '@nessie/workspace-admin'

import type { RunContext } from './types.js'

export class GlobalAgentPlacementError extends Error {
  override readonly name = 'GlobalAgentPlacementError'
  readonly code = 'GLOBAL_AGENT_INVALID_PLACEMENT'

  constructor() {
    super('A global agent may only run in its own per-user home DM.')
  }
}

/**
 * A DM-homed global agent runs in its own home DM and nowhere else.
 *
 * The bootstrap writes the only binding and `bindAgentToChannel` refuses every
 * system channel, but old or manual rows survive deployments — and the
 * consequences here are identity, not just placement: the home DM is where
 * `effectiveUserId = poster` is stamped, so a global agent speaking anywhere
 * else would be delegating from a person who is not the sole member.
 *
 * Trigger threads are deliberately NOT in the allowed set, unlike the
 * private-agent rule: v1 blueprints declare `allowsSelfTriggers: false` and
 * `createAgentTrigger` refuses a `systemSlug` target, so a trigger thread for
 * one of these can only be a leftover.
 */
export const assertGlobalAgentRunPlacement = (context: RunContext): void => {
  const slug = context.agent.systemSlug
  if (!slug) return

  const blueprint = getGlobalAgentBlueprint(slug)
  // An unknown slug is a row whose blueprint was withdrawn by a deploy. Fail
  // closed rather than running a definition this deployment no longer holds.
  if (!blueprint || blueprint.home !== 'per_user_dm') {
    throw new GlobalAgentPlacementError()
  }

  const dmKey = context.channel.dmKey
  if (
    context.channel.systemChannelType !== 'system_agent'
    || !dmKey
    // The encoded person is whoever this home belongs to; the sole-membership
    // trigger proves they are its only member. What is checked here is that the
    // destination is *a* home of *this* blueprint in *this* organisation.
    || !dmKey.startsWith(
      globalAgentHomePrefix({ organizationId: context.channel.organizationId, slug }),
    )
  ) {
    throw new GlobalAgentPlacementError()
  }
}
