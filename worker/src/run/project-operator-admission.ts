import type { PrismaClient } from '@prisma/client'
import { PROJECT_OPERATOR_CAPABILITY_ID, PROJECT_OPERATOR_TOOL_IDS } from '@nessie/runtime'

import type { AgentKind } from './tool-policy.js'

/**
 * The project-operator arm: an ordinary agent setting up projects and flows
 * for the live person talking to it — and on no other run
 * (docs/standards/personal-assistant-tools.md → "The project-operator
 * capability"; docs/standards/global-agents.md → the two-lock rule).
 *
 * Resolved ONCE at run setup and handed to both `resolveAgentTools` (an
 * operator verb the run may not call is omitted from its schema, never offered
 * then denied) and `authorizeToolCall` (a stale schema cannot be exercised),
 * exactly as the identity arm is. Every handler then re-checks the same
 * conditions against live rows (`pa-tools/project-operator.ts`).
 */

export type LiveRequesterRunFacts = {
  actorId: string
  actorType: string
  agentKind: AgentKind
  /** The destination channel. A system conversation or a DM is never a project room. */
  channel: { dmKey?: string | null; systemChannelType?: string | null }
  effectiveUserId?: string | null
  interactive: boolean
  parentAgentId: string | null
  /** `actionContext.purpose`: set on every kickoff that is not a person's own turn. */
  purpose?: string | null
  systemManaged: boolean
  systemSlug?: string | null
}

/**
 * "A person is talking to this ordinary agent, right now, in a project room" —
 * structural facts only, never content.
 *
 * - An ordinary shared agent: not the Personal Assistant, not a global or
 *   otherwise system-managed agent, not a spawned child.
 * - A user actor on an interactive turn. A trigger fire, a schedule, a
 *   checkpoint continuation, an agent-authored post and a subtask are none of
 *   those, and a scheduled fire that reconstructs its creator's
 *   `effectiveUserId` still has no interactive person behind it.
 * - No action purpose at all. A person's own chat turn carries none; every
 *   kickoff that speaks for someone else does — `ticket.work` (the agent acting
 *   as itself), `agent.peer_delegation`, `channel.policy`, the delivery and
 *   brief purposes — so an allow-list of "no purpose" fails closed on the next
 *   one somebody adds.
 * - `effectiveUserId` absent, or the actor: a run that carries somebody else's
 *   identity is not that person asking.
 * - An ordinary channel (no system conversation, no DM). The binding is the
 *   caller's to add: see `resolveRunProjectOperatorToolIds`.
 */
export const isLiveRequesterRun = (facts: LiveRequesterRunFacts): boolean =>
  facts.agentKind === 'shared'
  && !facts.systemManaged
  && !facts.systemSlug
  && facts.parentAgentId === null
  && facts.actorType === 'user'
  && facts.interactive === true
  && (facts.purpose === undefined || facts.purpose === null)
  && (!facts.effectiveUserId || facts.effectiveUserId === facts.actorId)
  && !facts.channel.systemChannelType
  && !facts.channel.dmKey

const NO_OPERATOR_TOOLS: ReadonlySet<string> = new Set<string>()

/**
 * The operator verbs a run may call: all of them when the run is a live
 * requester's, the agent is bound to the channel, the deployment has not
 * switched the capability off for the organisation, and the agent's policy
 * carries the explicit `project_operator` grant; otherwise none. Pure.
 */
export const resolveProjectOperatorToolIds = (input: {
  bound: boolean
  capabilityEnabled: boolean
  live: boolean
  toolPolicy: Record<string, boolean> | null
}): ReadonlySet<string> =>
  input.live && input.bound && input.capabilityEnabled
  && input.toolPolicy?.[PROJECT_OPERATOR_CAPABILITY_ID] === true
    ? PROJECT_OPERATOR_TOOL_IDS
    : NO_OPERATOR_TOOLS

/**
 * An owner can switch any builtin off for the whole organisation, and the
 * capability is a registry entry like one: an absent row is on (the registry
 * is seeded lazily), a row that says `enabled: false` is off.
 */
export const isProjectOperatorCapabilityEnabled = async (
  prisma: Pick<PrismaClient, 'toolRegistryEntry'>,
  organizationId: string,
): Promise<boolean> => {
  const entry = await prisma.toolRegistryEntry.findFirst({
    where: { builtin: true, organizationId, scopeKey: 'builtin', toolId: PROJECT_OPERATOR_CAPABILITY_ID },
    select: { enabled: true },
  })
  return entry?.enabled !== false
}

/**
 * Run setup's one call. The cheap structural checks run first, so an agent
 * without the grant — nearly every run — costs no query at all.
 */
export const resolveRunProjectOperatorToolIds = async (
  prisma: Pick<PrismaClient, 'agentBinding' | 'toolRegistryEntry'>,
  input: LiveRequesterRunFacts & {
    agentId: string
    channelId: string
    organizationId: string
    toolPolicy: Record<string, boolean> | null
  },
): Promise<ReadonlySet<string>> => {
  const live = isLiveRequesterRun(input)
  if (!live || input.toolPolicy?.[PROJECT_OPERATOR_CAPABILITY_ID] !== true) return NO_OPERATOR_TOOLS
  const [bindings, capabilityEnabled] = await Promise.all([
    prisma.agentBinding.count({ where: { agentId: input.agentId, channelId: input.channelId } }),
    isProjectOperatorCapabilityEnabled(prisma, input.organizationId),
  ])
  return resolveProjectOperatorToolIds({
    bound: bindings > 0,
    capabilityEnabled,
    live,
    toolPolicy: input.toolPolicy,
  })
}
