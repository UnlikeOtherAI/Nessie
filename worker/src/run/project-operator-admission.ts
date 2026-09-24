import type { PrismaClient } from '@prisma/client'
import { PROJECT_OPERATOR_CAPABILITY_ID, PROJECT_OPERATOR_TOOL_IDS } from '@nessie/runtime'
import { isPersonAuthoredMessageMetadata, type RunExecuteJobPayload } from '@nessie/schemas'

import type { AgentKind } from './tool-policy.js'

/**
 * The project-operator arm: an ordinary agent setting up projects and flows
 * for the live person talking to it — and on no other run
 * (docs/standards/personal-assistant-tools.md → "The project-operator
 * capability"; docs/standards/global-agents.md → the two-lock rule).
 *
 * One loader (`loadProjectOperatorFacts`) and one verdict
 * (`projectOperatorRefusal`) serve both locks: run setup resolves the arm's
 * verbs from them, once, for the schema and the per-call gate alike, and every
 * handler re-reads the same facts at the moment of the call
 * (`pa-tools/project-operator.ts`). So a verb is never offered by one answer
 * and refused by another.
 */

/** The run's own facts: who its turn names, and what kind of turn it is. */
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
 * - A user actor on an interactive turn. A trigger fire, a schedule, a worker
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
 * - Not a system conversation and not a DM. The rest of the room — a live,
 *   ordinary channel of a real project the agent is bound to — and the
 *   person's own messages are `projectOperatorRefusal`'s.
 *
 * "User actor + interactive" is not enough on its own: Restart and Continue
 * put the presser in as the actor and replay the original kickoff, a card or
 * approval resumes as the parked run's actor whoever pressed, and a drain
 * takes its latest person's actor while folding in others' messages. The
 * turn itself is checked by `isPersonsOwnTurn`.
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

/** A message as the turn check reads it. */
export type RequesterMessage = {
  deletedAt: Date | null
  id: string
  metadata: unknown
  role: string
  threadId: string
  userId: string | null
}

/**
 * The person typed it into a composer and sent it: a user message by the
 * actor, in this conversation, not deleted, carrying the person-authorship
 * marker only a composer route writes (`isPersonAuthoredMessageMetadata`). A
 * relayed post, a trigger kickoff, a card press, inbound mail and every
 * server-authored row carry none. The same test the executor conversation
 * lease makes of every message it carries on (`executor-lease-carry.ts`).
 */
const isPersonsOwnMessage = (message: RequesterMessage, actorId: string, threadId: string): boolean =>
  message.threadId === threadId
  && message.role === 'user'
  && message.userId === actorId
  && message.deletedAt === null
  && isPersonAuthoredMessageMetadata(message.metadata)

/**
 * The turn is the actor's own:
 *
 * - the message the run answers is the run row's own trigger, and it is the
 *   actor's own composer message in this conversation — so a Restart or a
 *   Continue of somebody else's run, or of a webhook, cron or ticket-work run,
 *   replays input that is not the presser's and is refused;
 * - every message a drain folded in is the actor's own too;
 * - a run that replays another — a Continue, a card or approval resume, a
 *   Restart — names who pressed, and that is the actor: a card answered by
 *   somebody else does not steer the parked person's rights.
 */
export const isPersonsOwnTurn = (input: {
  actorId: string
  batchMessageIds?: readonly string[] | null
  messageId: string
  messages: readonly RequesterMessage[]
  resumedByUserId?: string | null
  run: { continuationOfRunId: string | null; restartOfRunId: string | null; triggerMessageId: string | null } | null
  threadId: string
}): boolean => {
  if (!input.run || input.run.triggerMessageId !== input.messageId) return false
  if (input.batchMessageIds && !input.batchMessageIds.includes(input.messageId)) return false
  const byId = new Map(input.messages.map((message) => [message.id, message]))
  const ids = [...new Set([input.messageId, ...(input.batchMessageIds ?? [])])]
  if (ids.some((id) => {
    const message = byId.get(id)
    return !message || !isPersonsOwnMessage(message, input.actorId, input.threadId)
  })) return false
  const replays = input.run.continuationOfRunId !== null || input.run.restartOfRunId !== null
  return !replays || input.resumedByUserId === input.actorId
}

/** What the loader reads, for the run and for each call. */
export type ProjectOperatorRunInput = {
  actorId: string
  actorType: string
  agentId: string
  batchMessageIds?: readonly string[] | null
  channelId: string
  effectiveUserId?: string | null
  interactive: boolean
  messageId: string
  organizationId: string
  purpose?: string | null
  resumedByUserId?: string | null
  runId: string
  threadId: string
}

/** The loader's input from a run job and where it runs. */
export const projectOperatorRunInputOfJob = (
  job: Pick<RunExecuteJobPayload, 'actorContext' | 'batchMessageIds' | 'interactive' | 'messageId' | 'resumedByUserId'>,
  run: { agentId: string; channelId: string; organizationId: string; runId: string; threadId: string },
): ProjectOperatorRunInput => ({
  ...run,
  actorId: job.actorContext.actor.actorId,
  actorType: job.actorContext.actor.actorType,
  batchMessageIds: job.batchMessageIds ?? null,
  effectiveUserId: job.actorContext.actionContext.effectiveUserId ?? null,
  interactive: job.interactive === true,
  messageId: job.messageId,
  purpose: job.actorContext.actionContext.purpose ?? null,
  resumedByUserId: job.resumedByUserId ?? null,
})

const MESSAGE_SELECT = { deletedAt: true, id: true, metadata: true, role: true, threadId: true, userId: true } as const

/**
 * Every fact the verdict reads, from live rows: the agent, the room and its
 * project, the binding, the organisation's switch, the run row and the
 * messages its turn names.
 */
export const loadProjectOperatorFacts = async (
  prisma: Pick<PrismaClient, 'agent' | 'agentBinding' | 'channel' | 'message' | 'run' | 'toolRegistryEntry'>,
  input: ProjectOperatorRunInput,
) => {
  const ids = [...new Set([input.messageId, ...(input.batchMessageIds ?? [])])]
  const [agent, channel, bindings, capabilityEnabled, run, messages] = await Promise.all([
    prisma.agent.findFirst({
      where: { deletedAt: null, id: input.agentId, organizationId: input.organizationId },
      select: { agentKind: true, parentAgentId: true, systemManaged: true, systemSlug: true, toolPolicy: true },
    }),
    prisma.channel.findFirst({
      where: { id: input.channelId, organizationId: input.organizationId },
      select: {
        archivedAt: true, deletedAt: true, dmKey: true, projectId: true, systemChannelType: true, type: true,
        project: { select: { channelRoot: true, deletedAt: true } },
      },
    }),
    prisma.agentBinding.count({ where: { agentId: input.agentId, channelId: input.channelId } }),
    isProjectOperatorCapabilityEnabled(prisma, input.organizationId),
    prisma.run.findUnique({
      where: { id: input.runId },
      select: { continuationOfRunId: true, restartOfRunId: true, triggerMessageId: true },
    }),
    prisma.message.findMany({ where: { id: { in: ids } }, select: MESSAGE_SELECT }),
  ])
  return { agent, bindings, capabilityEnabled, channel, input, messages, run }
}

export type ProjectOperatorFacts = Awaited<ReturnType<typeof loadProjectOperatorFacts>>

/** Why the arm stays shut, in structural terms; null when it opens. */
export type ProjectOperatorRefusal =
  | 'no_grant'
  | 'not_a_live_turn'
  | 'not_a_project_room'
  | 'not_bound'
  | 'not_the_persons_own_turn'
  | 'switched_off'

const policyOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export const projectOperatorRefusal = (facts: ProjectOperatorFacts): ProjectOperatorRefusal | null => {
  const { agent, channel, input } = facts
  if (!agent || policyOf(agent.toolPolicy)[PROJECT_OPERATOR_CAPABILITY_ID] !== true) return 'no_grant'
  if (!facts.capabilityEnabled) return 'switched_off'
  // A live, ordinary room of a real project: not a system conversation, not a
  // DM, and not an organisation-wide channel, which lives in the invisible
  // `channelRoot` container that is no project anybody is in.
  if (
    !channel || channel.type !== 'standard' || channel.archivedAt || channel.deletedAt
    || channel.systemChannelType || channel.dmKey
    || channel.project.channelRoot || channel.project.deletedAt
  ) return 'not_a_project_room'
  if (facts.bindings === 0) return 'not_bound'
  if (!isLiveRequesterRun({
    actorId: input.actorId,
    actorType: input.actorType,
    agentKind: agent.agentKind,
    channel: { dmKey: channel.dmKey, systemChannelType: channel.systemChannelType },
    effectiveUserId: input.effectiveUserId,
    interactive: input.interactive,
    parentAgentId: agent.parentAgentId,
    purpose: input.purpose,
    systemManaged: agent.systemManaged,
    systemSlug: agent.systemSlug,
  })) return 'not_a_live_turn'
  if (!isPersonsOwnTurn({
    actorId: input.actorId,
    batchMessageIds: input.batchMessageIds,
    messageId: input.messageId,
    messages: facts.messages,
    resumedByUserId: input.resumedByUserId,
    run: facts.run,
    threadId: input.threadId,
  })) return 'not_the_persons_own_turn'
  return null
}

/**
 * What a verb answers when the person's own turn is what is missing — a worker
 * continuation of a long turn, a Continue, a Restart, a card somebody else
 * answered, a trigger. Addressed to the situation, not the model: the way on
 * is the person repeating the request on a turn of their own.
 */
export const PROJECT_OPERATOR_LIVE_TURN_REFUSAL =
  'This sets things up as the person talking to you, so it works only on their own turn, from a '
  + 'message they sent you themselves — not a continuation, a restart, a card someone else answered '
  + 'or a trigger. If you were setting something up for them, say what is done so far and ask them '
  + 'to repeat the request.'

/**
 * The gate's own words for a verb it refused because nobody is asking right
 * now: a `requiresLiveRequester` verb off a live turn, or an operator verb on
 * a run that is not one (a worker continuation of a long setup turn loses the
 * arm midway). Null for every other refusal, which keeps the generic sentence.
 */
export const liveTurnDenialMessage = (
  toolName: string,
  reason: string,
  run: { liveRequester: boolean; toolPolicy: Record<string, boolean> | null },
): string | null =>
  reason === 'live_requester_required'
  || (!run.liveRequester && PROJECT_OPERATOR_TOOL_IDS.has(toolName)
    && run.toolPolicy?.[PROJECT_OPERATOR_CAPABILITY_ID] === true)
    ? PROJECT_OPERATOR_LIVE_TURN_REFUSAL
    : null

const NO_OPERATOR_TOOLS: ReadonlySet<string> = new Set<string>()

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
 * Run setup's one call. An agent without the grant — nearly every run — costs
 * no query at all; one with it reads the same facts every call re-reads.
 */
export const resolveRunProjectOperatorToolIds = async (
  prisma: Parameters<typeof loadProjectOperatorFacts>[0],
  input: ProjectOperatorRunInput & { toolPolicy: Record<string, boolean> | null },
): Promise<ReadonlySet<string>> => {
  if (input.toolPolicy?.[PROJECT_OPERATOR_CAPABILITY_ID] !== true) return NO_OPERATOR_TOOLS
  if (input.actorType !== 'user' || !input.interactive) return NO_OPERATOR_TOOLS
  const refusal = projectOperatorRefusal(await loadProjectOperatorFacts(prisma, input))
  return refusal === null ? PROJECT_OPERATOR_TOOL_IDS : NO_OPERATOR_TOOLS
}
