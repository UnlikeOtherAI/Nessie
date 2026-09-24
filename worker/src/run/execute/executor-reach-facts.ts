// Machine-reach facts (docs/executor-protocol/conversation-leases.md → "What
// the agent is told").
//
// One line, or none, telling the model what it can reach on a person's
// machine this turn: the local-apps pair is bound, a conversation lease exists
// but did not carry and why, or the agent is granted local apps and nothing
// binds them. Every input is structural — the run's own bindings, the lease
// outcome run setup recorded, the agent's grant rows, the room's membership —
// never message content. The facts change from run to run (the lease's window
// moves on every carry), so the prompt places them outside the byte-stable
// cache anchor.

import type { PrismaClient } from '@prisma/client'
import {
  EXECUTOR_LOCAL_APPS_OPERATION_KEYS,
  executorCodingSessionOwnerKey,
  STANDING_POLICY_REFUSAL_SENTENCES,
  type StandingPolicyRefusalReason,
} from '@nessie/executor-manage'
import {
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  ExecutorCapabilityDescriptorSchema,
  ExecutorLocalMcpReportSchema,
} from '@nessie/schemas'

import { CODING_AGENT_LABELS, CODING_SESSION_TOOL_NAME_SET } from '../coding-session-tools.js'
import type { ExecutorHostOutputDisclosure } from '../executor-host-output.js'
import { executorToolName } from '../executor-toolset.js'
import type { TicketWorkMachine } from './ticket-work-setup.js'
import type { ExecutorLeaseCarryOutcome, ExecutorLeaseRefusalReason } from './types.js'

/** The first-class coding-session tools, when the toolset holds them. */
export type ExecutorCodingSessionsReach = {
  /** The coding agents the reviewed facts offer, as a person knows them. */
  agents: string[]
  roots: string[]
  /**
   * The open sessions this agent holds there for this person, as the machine
   * last reported them; null when its report did not list sessions at all.
   * A title is the first line of a task, which may have been written in
   * another conversation, so it is carried only in the person's own DM.
   */
  sessions: Array<{ sessionId: string; status: string; title?: string }> | null
}

export type ExecutorReachFacts =
  /**
   * The local-apps pair is in this run's toolset, or the coding-session
   * tools on top of it are. `servers` is what the bound revision's reviewed
   * policy lets the pair reach (null when that descriptor no longer parses) —
   * every named program but the coding bridge, which the pair never reaches.
   * `pair: false` says the pair itself is not held, which happens
   * when the bridge is the only program named. `executorLabel` is set only in
   * a DM nobody but the person reads; `leaseExpiresAt` only while a live
   * lease covers the run.
   */
  | {
    codingSessions?: ExecutorCodingSessionsReach
    executorLabel: string | null
    kind: 'bound'
    leaseExpiresAt: Date | null
    pair?: false
    servers: string[] | null
  }
  /** A lease covers this conversation and did not reach this run. */
  | { kind: 'refused'; reason: ExecutorLeaseRefusalReason }
  /**
   * A `ticket.work` run whose pinned machine the standing binder refused this
   * turn. A standing bind itself reads as `bound`, with no label: its thread
   * is a public room, and the DM-only naming rule never names a machine there.
   */
  | { kind: 'standing_refused'; reason: StandingPolicyRefusalReason }
  /** The agent is granted local apps, and nothing in this conversation binds them. */
  | { kind: 'unbound' }

const LOCAL_APPS_TOOL_NAMES = EXECUTOR_LOCAL_APPS_OPERATION_KEYS.map(executorToolName)
const NO_MACHINE_TOOLS = 'You have no machine tools this turn.'
const EXECUTOR_LABEL_MAXIMUM = 80

// One line per refusal. None names the machine: a lease can sit in a shared
// room whose other members may not know the executor exists.
const REFUSAL_LINES: Record<ExecutorLeaseRefusalReason, string> = {
  actor_not_holder: 'Machine tools only come with messages from the person who started the session.',
  not_interactive:
    'Machine tools only come with a live message from the person who started the session, and this turn is not one.',
  trigger_not_person:
    'Machine tools only come with messages the person who started the session sends from the composer themselves, '
    + 'and this turn\'s message did not come from there.',
  batch_not_person:
    'This turn answers several messages, and machine tools only come when every one of them is from the person '
    + 'who started the session.',
  lease_ended:
    'The session ended; if the person still wants it, they can start local apps again from the composer.',
  executor_unavailable:
    'The machine is offline or its policy changed; ask the person to start local apps again from the composer.',
}

const formatUtcMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

const SESSIONS_LISTED = 5
const SESSION_TITLE_MAXIMUM = 80

const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const codingSentences = (coding: ExecutorCodingSessionsReach, machine: string): string => {
  const reach = `You can have a coding agent on ${machine} (${coding.agents.join(', ')}, in the folders `
    + `${coding.roots.join(', ')}) do coding work through the \`coding_session_*\` tools: you brief it, follow it, `
    + 'and review what it changed; you never write the code yourself.'
  if (coding.sessions === null) return reach
  if (coding.sessions.length === 0) return `${reach} You hold no open coding sessions there.`
  const listed = coding.sessions.slice(0, SESSIONS_LISTED).map((session) => (session.title === undefined
    ? `${session.sessionId} (${session.status})`
    : `${session.sessionId} ${JSON.stringify(oneLine(session.title, SESSION_TITLE_MAXIMUM))} (${session.status})`))
  const more = coding.sessions.length > SESSIONS_LISTED ? `, and ${coding.sessions.length - SESSIONS_LISTED} more` : ''
  return `${reach} Coding sessions you hold there, as the machine last reported them: ${listed.join('; ')}${more}.`
}

/** The prompt block for these facts, or null when there is nothing to say. */
export const buildExecutorReachBlock = (facts: ExecutorReachFacts | null): string | null => {
  if (!facts) return null
  switch (facts.kind) {
    case 'bound': {
      const named = facts.executorLabel
        ? `the person's machine, ${JSON.stringify(facts.executorLabel)}`
        : 'the person\'s machine'
      const machine = facts.executorLabel ? `${named},` : named
      const servers = facts.servers === null
        ? ''
        : facts.servers.length > 0
          ? ` (servers: ${facts.servers.join(', ')})`
          : ' (its reviewed policy names no server)'
      const tools = LOCAL_APPS_TOOL_NAMES.map((name) => `\`${name}\``).join(' / ')
      const sentences = [
        ...(facts.pair === false ? [] : [`This turn you can use programs on ${machine} through ${tools}${servers}.`]),
        ...(facts.codingSessions
          ? [codingSentences(facts.codingSessions, facts.pair === false ? named : 'that machine')]
          : []),
        // "This machine", never "this session": beside the coding sessions it
        // would read as one of them.
        ...(facts.leaseExpiresAt
          ? [`The person can keep using this machine in this conversation until `
            + `${formatUtcMinute(facts.leaseExpiresAt)} or until they end it.`]
          : []),
      ]
      return sentences.join(' ')
    }
    case 'refused':
      return `${NO_MACHINE_TOOLS} ${REFUSAL_LINES[facts.reason]}`
    case 'standing_refused':
      return `${NO_MACHINE_TOOLS} ${STANDING_POLICY_REFUSAL_SENTENCES[facts.reason]}`
    case 'unbound':
      return `${NO_MACHINE_TOOLS} A person starts them from the composer: Run on executor → Local apps on this machine.`
  }
}

/**
 * The executor's own label may reach the model only where the reply can reach
 * nobody but that person: a DM with no other human member. Anywhere else the
 * facts name the servers and never the machine.
 */
const isPersonsOwnDm = async (
  prisma: PrismaClient,
  channelId: string,
  personUserId: string | null,
): Promise<boolean> => {
  if (!personUserId) return false
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { type: true, members: { where: { userId: { not: personUserId } }, select: { id: true }, take: 1 } },
  })
  return channel?.type === 'dm' && channel.members.length === 0
}

const labelFor = (label: string): string | null =>
  label.replace(/\s+/g, ' ').trim().slice(0, EXECUTOR_LABEL_MAXIMUM) || null

/** Both halves of the pair allowed on one live executor. */
const holdsLocalAppsGrant = async (
  prisma: PrismaClient,
  input: { agentId: string; organizationId: string },
): Promise<boolean> => {
  const grants = await prisma.executorAgentOperationGrant.findMany({
    where: {
      agentId: input.agentId,
      executor: { organizationId: input.organizationId, status: { not: 'revoked' } },
      operationKey: { in: [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS] },
      state: 'allowed',
    },
    select: { executorId: true, operationKey: true },
  })
  const keysByExecutor = new Map<string, Set<string>>()
  for (const grant of grants) {
    const keys = keysByExecutor.get(grant.executorId) ?? new Set<string>()
    keys.add(grant.operationKey)
    keysByExecutor.set(grant.executorId, keys)
  }
  return [...keysByExecutor.values()].some((keys) => keys.size === EXECUTOR_LOCAL_APPS_OPERATION_KEYS.length)
}

type ReachBinding = {
  capabilityRevision: { descriptor: unknown }
  executor: { label: string; localMcp?: unknown; pairingOwnerUserId?: string }
  executorId?: string
}

/**
 * The coding sessions this agent holds on the machine for its pairing owner —
 * the one person the tools are offered to, so the one whose owner key the
 * bridge filed them under — from the local-MCP report its last heartbeat
 * carried. A lease is per conversation and a session per owner, so these are
 * the person's sessions with this agent on that machine, wherever they began
 * — and so a title, the first line of a task written perhaps in the person's
 * DM, is carried only when `withTitles` says this is that DM.
 */
const reportedOwnSessions = (
  binding: ReachBinding,
  agentId: string,
  withTitles: boolean,
  /** A ticket's own owner context, for a standing bind: its sessions and no one else's. */
  contextId?: string,
): ExecutorCodingSessionsReach['sessions'] => {
  const { executor, executorId } = binding
  if (!executorId || !executor.pairingOwnerUserId) return null
  const report = ExecutorLocalMcpReportSchema.safeParse(executor.localMcp)
  const listed = report.success
    ? report.data.find((status) => status.server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME)?.codingSessions
    : undefined
  if (!listed) return null
  const ownerKey = executorCodingSessionOwnerKey(executorId, {
    actorUserId: executor.pairingOwnerUserId, agentId, ...(contextId ? { contextId } : {}),
  })
  return listed
    .filter((session) => session.ownerKey === ownerKey && session.status !== 'closed')
    .map((session) => ({
      sessionId: session.sessionId, status: session.status, ...(withTitles ? { title: session.title } : {}),
    }))
}

/**
 * Derive the facts once the executor toolset is built. `toolNames` is that
 * toolset's `handledNames`: "bound" is said only when the model really holds
 * both tools of the pair, or the coding-session tools, because the toolset
 * can still drop a bound operation (the agent's tool policy, a missing
 * transport key, the coding rule).
 *
 * Session titles come from the machine, so a block that carries them stamps
 * the run's basis with the launch conversation, exactly as the coding tools'
 * own answers do (`hostOutput`, `executor-host-output.ts`).
 */
export const loadExecutorReachFacts = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId: string
    hostOutput: ExecutorHostOutputDisclosure | null
    lease: ExecutorLeaseCarryOutcome | undefined
    organizationId: string
    /** The job's acting person, or null when no person acts. */
    personUserId: string | null
    runId: string
    /** A `ticket.work` run's standing bind, when run setup made one. */
    standing?: TicketWorkMachine | undefined
    toolNames: ReadonlySet<string>
  },
): Promise<ExecutorReachFacts | null> => {
  const standing = input.standing?.binding
  if (standing?.kind === 'refused') return { kind: 'standing_refused', reason: standing.reason }
  if (standing?.kind === 'not_applicable') return null
  const lease: ExecutorLeaseCarryOutcome | undefined = standing
    ? { kind: 'already_bound', lease: null }
    : input.lease
  if (!lease) return null
  if (lease.kind === 'refused') return { kind: 'refused', reason: lease.reason }
  const leaseSummary = lease.kind === 'no_lease' ? null : lease.lease
  // Bound under a lease that has since ended or run out: dispatch fences these.
  if (leaseSummary && !leaseSummary.live) return { kind: 'refused', reason: 'lease_ended' }
  const pair = LOCAL_APPS_TOOL_NAMES.every((name) => input.toolNames.has(name))
  const coding = [...CODING_SESSION_TOOL_NAME_SET].every((name) => input.toolNames.has(name))
  if (pair || coding) {
    const [binding, ownDm] = await Promise.all([
      prisma.executorBinding.findFirst({
        where: { runId: input.runId, operationKey: EXECUTOR_LOCAL_APPS_OPERATION_KEYS[0] },
        select: {
          capabilityRevision: { select: { descriptor: true } },
          executor: { select: { label: true, localMcp: true, pairingOwnerUserId: true } },
          executorId: true,
        },
      }),
      isPersonsOwnDm(prisma, input.channelId, input.personUserId),
    ])
    const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(binding?.capabilityRevision.descriptor)
    const facts = descriptor.success ? descriptor.data.codingSessions : undefined
    const codingSessions: ExecutorCodingSessionsReach | undefined = coding && facts && binding
      ? {
          agents: facts.agents.map((agent) => CODING_AGENT_LABELS[agent]),
          roots: facts.rootNames,
          sessions: reportedOwnSessions(binding, input.agentId, ownDm, input.standing?.coding?.contextId),
        }
      : undefined
    if (codingSessions?.sessions?.some((session) => session.title !== undefined) && input.hostOutput) {
      input.hostOutput.sink.addHostOutputScope(input.hostOutput.launchScope)
    }
    const servers = descriptor.success ? descriptor.data.mcpServers ?? [] : null
    // The pair never reaches the bridge: its own tools do, for the one person
    // they are offered to, and the API refuses it to everyone else.
    const bridge = new Set([EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME, ...(facts ? [facts.serverName] : [])])
    return {
      ...(codingSessions ? { codingSessions } : {}),
      executorLabel: ownDm && binding ? labelFor(binding.executor.label) : null,
      kind: 'bound',
      leaseExpiresAt: leaseSummary?.expiresAt ?? null,
      ...(pair ? {} : { pair: false as const }),
      servers: servers && servers.filter((server) => !bridge.has(server)),
    }
  }
  // Carried or launched under a live lease, yet the toolset exposed no pair.
  if (leaseSummary) return { kind: 'refused', reason: 'executor_unavailable' }
  // Another bundle is bound; it says nothing about local apps.
  if (lease.kind === 'already_bound') return null
  return await holdsLocalAppsGrant(prisma, input) ? { kind: 'unbound' } : null
}
