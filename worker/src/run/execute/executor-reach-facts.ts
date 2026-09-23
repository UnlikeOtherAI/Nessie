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
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from '@nessie/executor-manage'
import { ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'

import { executorToolName } from '../executor-toolset.js'
import type { ExecutorLeaseCarryOutcome, ExecutorLeaseRefusalReason } from './types.js'

export type ExecutorReachFacts =
  /**
   * The local-apps pair is in this run's toolset. `servers` is what the bound
   * revision's reviewed policy names (null when that descriptor no longer
   * parses). `executorLabel` is set only in a DM nobody but the person reads;
   * `leaseExpiresAt` only while a live lease covers the run.
   */
  | { kind: 'bound'; executorLabel: string | null; leaseExpiresAt: Date | null; servers: string[] | null }
  /** A lease covers this conversation and did not reach this run. */
  | { kind: 'refused'; reason: ExecutorLeaseRefusalReason }
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

/** The prompt block for these facts, or null when there is nothing to say. */
export const buildExecutorReachBlock = (facts: ExecutorReachFacts | null): string | null => {
  if (!facts) return null
  switch (facts.kind) {
    case 'bound': {
      const machine = facts.executorLabel
        ? `the person's machine, ${JSON.stringify(facts.executorLabel)},`
        : 'the person\'s machine'
      const servers = facts.servers === null
        ? ''
        : facts.servers.length > 0
          ? ` (servers: ${facts.servers.join(', ')})`
          : ' (its reviewed policy names no server)'
      const tools = LOCAL_APPS_TOOL_NAMES.map((name) => `\`${name}\``).join(' / ')
      const reach = `This turn you can use programs on ${machine} through ${tools}${servers}.`
      return facts.leaseExpiresAt
        ? `${reach} The person who started this session can keep using it in this conversation until `
          + `${formatUtcMinute(facts.leaseExpiresAt)} or until they end it.`
        : reach
    }
    case 'refused':
      return `${NO_MACHINE_TOOLS} ${REFUSAL_LINES[facts.reason]}`
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

/**
 * Derive the facts once the executor toolset is built. `toolNames` is that
 * toolset's `handledNames`: "bound" is said only when the model really holds
 * both tools, because the toolset can still drop a bound operation (the
 * agent's tool policy, a missing transport key).
 */
export const loadExecutorReachFacts = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    channelId: string
    lease: ExecutorLeaseCarryOutcome | undefined
    organizationId: string
    /** The job's acting person, or null when no person acts. */
    personUserId: string | null
    runId: string
    toolNames: ReadonlySet<string>
  },
): Promise<ExecutorReachFacts | null> => {
  const { lease } = input
  if (!lease) return null
  if (lease.kind === 'refused') return { kind: 'refused', reason: lease.reason }
  const leaseSummary = lease.kind === 'no_lease' ? null : lease.lease
  // Bound under a lease that has since ended or run out: dispatch fences these.
  if (leaseSummary && !leaseSummary.live) return { kind: 'refused', reason: 'lease_ended' }
  if (LOCAL_APPS_TOOL_NAMES.every((name) => input.toolNames.has(name))) {
    const [binding, ownDm] = await Promise.all([
      prisma.executorBinding.findFirst({
        where: { runId: input.runId, operationKey: EXECUTOR_LOCAL_APPS_OPERATION_KEYS[0] },
        select: { capabilityRevision: { select: { descriptor: true } }, executor: { select: { label: true } } },
      }),
      isPersonsOwnDm(prisma, input.channelId, input.personUserId),
    ])
    const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(binding?.capabilityRevision.descriptor)
    return {
      executorLabel: ownDm && binding ? labelFor(binding.executor.label) : null,
      kind: 'bound',
      leaseExpiresAt: leaseSummary?.expiresAt ?? null,
      servers: descriptor.success ? descriptor.data.mcpServers ?? [] : null,
    }
  }
  // Carried or launched under a live lease, yet the toolset exposed no pair.
  if (leaseSummary) return { kind: 'refused', reason: 'executor_unavailable' }
  // Another bundle is bound; it says nothing about local apps.
  if (lease.kind === 'already_bound') return null
  return await holdsLocalAppsGrant(prisma, input) ? { kind: 'unbound' } : null
}
