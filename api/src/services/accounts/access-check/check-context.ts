import type { PrismaClient } from '@prisma/client'
import { buildVisibleAgentWhere } from '@nessie/db'
import type {
  AccessCheckContext,
  AccessCheckRemedy,
  AccessCheckStep,
  AccessCheckStepId,
  AccountRecord,
  AuthorizedActionContext,
} from '@nessie/schemas'
import { buildAccessibleChannelWhere } from '@nessie/team-admin'

import type { AccountViewer } from '../account-sources.js'

/**
 * The facts every Check access evaluator reads: the agent as the runtime
 * reads it, and the place it is asked from reduced to what the runtime decides
 * with — who the run acts as, whether a person is live, the run's team, and
 * whether the agent is in that conversation at all.
 */

export type CheckAgent = {
  agentKind: 'shared' | 'personal_assistant'
  id: string
  modelSubscriptionId: string | null
  name: string
  ownerUserId: string | null
  provider: string | null
  systemManaged: boolean
  toolPolicy: unknown
}

export type CheckContext = {
  /** Whether the agent is in the conversation; always true outside a channel. */
  agentPlaced: boolean
  channel: { id: string; name: string } | null
  /**
   * A system agent's direct conversation (the Personal Assistant's, a global
   * agent's home) stamps the asking person as the run's effective user; that
   * is where a standing send permission can apply.
   */
  delegatedDm: boolean
  /** Who a run here acts as: the person asking, or nobody. */
  effectiveUserId: string | null
  interactive: boolean
  kind: AccessCheckContext['kind']
  teamId: string | null
}

/** The agent, only when the viewer may see it — the agents list's own rule. */
export const loadCheckAgent = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  agentId: string,
): Promise<CheckAgent | null> => {
  const agent = await prisma.agent.findFirst({
    select: {
      agentKind: true,
      id: true,
      modelSubscriptionId: true,
      name: true,
      ownerUserId: true,
      provider: true,
      systemManaged: true,
      toolPolicy: true,
    },
    where: {
      AND: [
        { id: agentId },
        buildVisibleAgentWhere({ organizationId: viewer.organizationId, userId: viewer.userId }),
      ],
    },
  })
  return agent
}

/**
 * The place the agent is asked from, or null when it is a conversation the
 * viewer cannot open — which the route answers as not found, so a check can
 * never reveal whether a conversation exists.
 */
export const resolveCheckContext = async (
  prisma: PrismaClient,
  viewer: AccountViewer,
  actor: AuthorizedActionContext,
  agent: CheckAgent,
  context: AccessCheckContext,
): Promise<CheckContext | null> => {
  const teamId = actor.tenant.teamId ?? null
  if (context.kind === 'unattended') {
    return {
      agentPlaced: true,
      channel: null,
      delegatedDm: false,
      effectiveUserId: null,
      interactive: false,
      kind: 'unattended',
      teamId,
    }
  }
  if (context.kind === 'direct') {
    return {
      agentPlaced: true,
      channel: null,
      delegatedDm: agent.systemManaged,
      effectiveUserId: viewer.userId,
      interactive: true,
      kind: 'direct',
      teamId,
    }
  }
  const room = await prisma.channel.findFirst({
    select: { id: true, label: true },
    where: {
      AND: [
        { id: context.channelId },
        buildAccessibleChannelWhere({ organizationId: viewer.organizationId, userId: viewer.userId }),
      ],
    },
  })
  if (!room) return null
  const channel = { id: room.id, name: room.label }
  const binding = await prisma.agentBinding.findFirst({
    select: { id: true },
    where: { agentId: agent.id, channelId: channel.id },
  })
  return {
    agentPlaced: binding !== null,
    channel,
    delegatedDm: false,
    // A live turn in a channel acts as the person who posted it.
    effectiveUserId: viewer.userId,
    interactive: true,
    kind: 'channel',
    teamId,
  }
}

// ─── Step builders ──────────────────────────────────────────────────────────

const step = (
  id: AccessCheckStepId,
  label: string,
  outcome: AccessCheckStep['outcome'],
  code: string,
  sentence: string,
  remedy: AccessCheckRemedy | null = null,
): AccessCheckStep => ({ id, label, outcome, reason: { code, sentence }, remedy })

export const pass = (id: AccessCheckStepId, label: string, code: string, sentence: string) =>
  step(id, label, 'pass', code, sentence)

export const warn = (id: AccessCheckStepId, label: string, code: string, sentence: string) =>
  step(id, label, 'warn', code, sentence)

export const skip = (id: AccessCheckStepId, label: string, code: string, sentence: string) =>
  step(id, label, 'skip', code, sentence)

export const fail = (
  id: AccessCheckStepId,
  label: string,
  code: string,
  sentence: string,
  remedy: AccessCheckRemedy | null,
) => step(id, label, 'fail', code, sentence, remedy)

/** Where an account's own page is: Your settings for a person's, Company connections otherwise. */
export const accountHref = (account: AccountRecord): string =>
  account.scope === 'person'
    ? `/settings/accounts/${account.id}`
    : `/admin/connections/${account.id}`

export const agentToolsHref = (agentId: string): string => `/admin/agents/${agentId}?agentTab=tools`

/** The account's own status, as the first step every check starts from. */
export const accountStep = (account: AccountRecord, viewerMayRepair: boolean): AccessCheckStep => {
  if (account.status.word === 'connected') {
    return pass('account', 'Signed in', 'connected', 'The account is connected.')
  }
  const remedy: AccessCheckRemedy | null = !viewerMayRepair || account.status.remedy === 'none'
    || account.status.remedy === 'wait'
    ? account.status.remedy === 'ask'
      ? { code: 'ask_admin', href: null, label: 'Ask an administrator' }
      : null
    : {
        code: account.status.remedy === 'finish_setup' ? 'finish_setup' : 'reconnect',
        href: accountHref(account),
        label: account.status.remedy === 'finish_setup' ? 'Finish connecting it' : 'Open the account',
      }
  return fail('account', 'Signed in', `account_${account.status.word}`, account.status.sentence, remedy)
}

/** In a channel, the agent has to be in the room before anything else there can apply. */
export const placementStep = (agent: CheckAgent, context: CheckContext): AccessCheckStep | null =>
  context.agentPlaced || !context.channel
    ? null
    : fail(
        'context',
        'Asked from here',
        'agent_not_in_conversation',
        `${agent.name} is not in ${context.channel.name}, so nobody can ask it there.`,
        { code: 'place_agent', href: null, label: 'Ask an owner or admin to add it' },
      )

/** The same place, in the words a summary uses. */
export const contextPhrase = (context: CheckContext): string =>
  context.kind === 'unattended'
    ? 'when nobody is asking'
    : context.kind === 'channel' && context.channel
      ? `when you ask it in ${context.channel.name}`
      : 'when you ask it directly'
