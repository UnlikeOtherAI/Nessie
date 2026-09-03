import { getGlobalAgentBlueprint } from '@nessie/team-admin'

import { isGlobalAgentHomeSurface } from '../delegated-identity.js'
import type { RunContext } from './types.js'

export class GlobalAgentPlacementError extends Error {
  override readonly name = 'GlobalAgentPlacementError'
  readonly code = 'GLOBAL_AGENT_INVALID_PLACEMENT'

  constructor() {
    super(
      'A global agent may only run in its own per-user home DM or in an '
      + 'ordinary channel it is bound to.',
    )
  }
}

/**
 * Where a DM-homed global agent may run: its own home DM, or an ordinary
 * channel it is genuinely bound to.
 *
 * The two arms are not the same permission and must not collapse into one.
 *
 * - **Its own home DM** is where identity delegation lives. The home DM is
 *   where `effectiveUserId = poster` is stamped and where the sole-membership
 *   trigger holds at rest, so `isGlobalAgentHomeSurface` — the same predicate
 *   the delegation gate and the identity-tool gate ask — is what admits it.
 *   Placement and identity can therefore never disagree about "its own home".
 * - **A bound ordinary channel** is the reachability arm (Rule zero): a global
 *   agent is an app-provided colleague and a team can put it in a room.
 *   The check is the *binding*, not the channel kind: `boundAgentIds` is the
 *   destination's live `AgentBinding` set, loaded once with the run context, so
 *   an unbound agent enqueued into a channel by a stale job still fails closed.
 *   It carries no identity — the identity gate keeps asking for the home DM, so
 *   a global agent in a shared room advises and cannot write agents.
 *
 * A system channel is never the second arm. Reaching that test already means
 * the first arm said no, so any `systemChannelType` here belongs to somebody
 * else's single-agent surface (another person's home of this blueprint, a PA
 * DM, an external product's DM) — exactly the case that must stay closed.
 *
 * An unknown slug is a row whose blueprint a deploy withdrew: it runs nowhere,
 * bound or not, rather than running a definition this deployment no longer
 * holds.
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
  if (!blueprint || blueprint.home !== 'per_user_dm') {
    throw new GlobalAgentPlacementError()
  }

  if (
    isGlobalAgentHomeSurface({
      agentKind: context.agent.agentKind,
      dmKey: context.channel.dmKey,
      organizationId: context.channel.organizationId,
      systemChannelType: context.channel.systemChannelType,
      systemSlug: slug,
    })
  ) {
    return
  }

  if (
    !context.channel.systemChannelType
    && context.boundAgentIds.includes(context.agent.id)
  ) {
    return
  }

  throw new GlobalAgentPlacementError()
}
