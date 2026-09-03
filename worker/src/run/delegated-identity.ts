import { getGlobalAgentBlueprint, globalAgentHomePrefix } from '@nessie/workspace-admin'
import type { GlobalAgentBlueprint } from '@nessie/workspace-admin'

import type { AgentKind } from './tool-policy.js'

/**
 * "This run delegates to its requesting person" — one structural predicate.
 *
 * The worker used to key that fact on `agentKind === 'personal_assistant'` in
 * five independent places (memory scope resolution, realtime scope narrowing,
 * reply attribution, the trigger membership re-check, the acting-member
 * helpers). The Personal Assistant was the only delegate, so kind and
 * delegation were the same fact wearing two hats. They are not the same fact:
 * the Agent Designer is `agentKind: 'shared'` and delegates just as completely,
 * so every one of those sites would have silently treated it as an ordinary
 * shared agent — PA *tools* with shared-agent *memory, scopes and attribution*,
 * the premise broken without a single failing check.
 *
 * The predicate is derived only from facts already on the run context: the
 * agent's kind, its `systemSlug` (resolved to a code blueprint), and the
 * destination's `systemChannelType` + `dmKey`. Never from message content.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D3).
 */

export type DelegatedRunFacts = {
  agentKind: AgentKind
  /** The global-agent blueprint this row instantiates, when it is one. */
  systemSlug?: string | null
  /** The destination channel's organisation — the home DM key encodes it. */
  organizationId: string
  systemChannelType: string | null | undefined
  dmKey?: string | null
}

const NO_IDENTITY_TOOLS: ReadonlySet<string> = new Set<string>()

/**
 * The single-member private DMs whose one bound agent acts as the person it is
 * talking to: the Personal Assistant's, and a DM-homed global agent's home.
 *
 * The channel-type-only half of the delegation fact, for the places that hold a
 * channel and no agent (realtime narrowing for a destination, the orchestrator's
 * structural fast path). Mirrors `isDelegatedSystemDmChannelType` on the api
 * side deliberately — one sentence, two processes, and neither may drift.
 */
export const isDelegatedSystemDmChannelType = (
  systemChannelType: string | null | undefined,
): boolean =>
  systemChannelType === 'personal_assistant' || systemChannelType === 'system_agent'

/**
 * The blueprint behind a `systemSlug`, when it is one this deployment still
 * ships AND one whose home is a per-user DM. An unknown slug is a row whose
 * blueprint a deploy withdrew: it delegates to nobody, exactly as it runs
 * nowhere (`assertGlobalAgentRunPlacement`).
 */
const dmHomedBlueprint = (
  systemSlug: string | null | undefined,
): GlobalAgentBlueprint | null => {
  const blueprint = getGlobalAgentBlueprint(systemSlug)
  return blueprint && blueprint.home === 'per_user_dm' ? blueprint : null
}

/**
 * The destination is *this* global agent's own home DM in *this* organisation.
 *
 * Sole membership of that DM is what makes `effectiveUserId = poster` true, and
 * the deferred `assert_private_agent_home_members` trigger holds it at rest —
 * so this check is the surface half of "acts as the person it is talking to".
 */
export const isGlobalAgentHomeSurface = (facts: DelegatedRunFacts): boolean => {
  const blueprint = dmHomedBlueprint(facts.systemSlug)
  if (!blueprint) return false

  const dmKey = facts.dmKey
  return facts.systemChannelType === 'system_agent'
    && dmKey != null
    && dmKey.startsWith(
      globalAgentHomePrefix({
        organizationId: facts.organizationId,
        slug: blueprint.slug,
      }),
    )
}

/**
 * True when this run acts as the person who is talking to it: the Personal
 * Assistant inside its own DM, or a DM-homed global agent inside its own home.
 *
 * Deliberately surface-keyed on both arms. A PA *presence* in a shared room
 * still carries its owner's `effectiveUserId`, but the room is not the owner's
 * private estate — the disclosure/scopes docs are explicit that the exemptions
 * key on the surface, never on the kind.
 */
export const runDelegatesToRequestingPerson = (facts: DelegatedRunFacts): boolean =>
  (facts.agentKind === 'personal_assistant'
    && facts.systemChannelType === 'personal_assistant')
  || isGlobalAgentHomeSurface(facts)

/**
 * True when the agent is structurally somebody's delegate, wherever it is
 * running. This is the *identity* half, without the surface condition: whose
 * accessible scopes a read resolves through. The PA answers as its owner in a
 * shared room too — what it may not do there is treat the room as private.
 */
export const agentActsAsRequestingPerson = (
  facts: Pick<DelegatedRunFacts, 'agentKind' | 'systemSlug'>,
): boolean =>
  facts.agentKind === 'personal_assistant' || dmHomedBlueprint(facts.systemSlug) !== null

/**
 * The live human whose identity an identity-delegated tool would exercise.
 *
 * Three conditions, all structural. `interactive` is the load-bearing one: a
 * trigger-fired run reconstructs an absent creator's `effectiveUserId`, so
 * without it a scheduled run could create agents and channels as that person.
 * Equality with the actor is the second lock — a single-member system DM stamps
 * `effectiveUserId = poster`, so anything else (a PA presence carrying an
 * owner while a different member asked) is not a delegation this may use.
 */
export const resolveDelegatedRequesterUserId = (input: {
  interactive?: boolean
  actorType: string
  actorId: string
  effectiveUserId?: string | null
}): string | null => {
  if (input.interactive !== true) return null
  if (input.actorType !== 'user') return null
  if (!input.effectiveUserId || input.effectiveUserId !== input.actorId) return null
  return input.actorId
}

/**
 * The `personalAssistantOnly` tool ids this run may exercise beyond the PA's
 * own arm (D3): the blueprint declares them, the run is on that blueprint's own
 * home DM, and it is an interactive turn from a live human requester.
 *
 * Returns the empty set for the Personal Assistant itself — it passes on its
 * own `agentKind` arm, and routing it through a blueprint list would be a
 * second answer to the same question.
 *
 * Note the deliberate belt-and-braces with phase 1's trigger refusal.
 * `createAgentTrigger` already refuses a `systemSlug` target, so a global agent
 * *should* have no scheduled runs at all. That refusal governs what can be
 * created from here on; this one governs what may be *exercised*, including by
 * a trigger row that predates the refusal or was written outside the
 * chokepoint. One lock protects the door, the other the safe.
 */
export const resolveIdentityDelegatedToolIds = (
  facts: DelegatedRunFacts,
  requesterUserId: string | null,
): ReadonlySet<string> => {
  if (facts.agentKind === 'personal_assistant') return NO_IDENTITY_TOOLS
  if (!requesterUserId) return NO_IDENTITY_TOOLS
  if (!isGlobalAgentHomeSurface(facts)) return NO_IDENTITY_TOOLS

  const blueprint = dmHomedBlueprint(facts.systemSlug)
  if (!blueprint || blueprint.identityToolIds.length === 0) return NO_IDENTITY_TOOLS
  return new Set(blueprint.identityToolIds)
}
