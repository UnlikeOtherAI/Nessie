import { Prisma, type PrismaClient } from '@prisma/client'

import { ensureDefaultThread } from './channel-records.js'
import { privateAgentHomeDmKey } from './private-agent-home.js'

type TransactionClient = PrismaClient | Prisma.TransactionClient

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Where a person and an agent talk.
 *
 * Two shapes, because an agent has two: a **private** agent has one home DM,
 * provisioned with it and owned by its owner, and a **shared** agent has one DM
 * per person who has ever addressed it. Both are keyed, both are idempotent,
 * and this is the only place either key is spelled.
 *
 * Lifted out of `api/src/services/channel-dms.ts` when the board watchers
 * needed to reach an agent from the worker, which cannot import the API. That
 * route still owns the interactive flow — permissions, the record it returns —
 * and calls `ensureSharedAgentDm` for the part that is the same either way.
 */

export const agentDmKey = (input: {
  agentId: string
  organizationId: string
  teamId: string
  userId: string
}): string =>
  [input.organizationId, input.teamId, input.userId, 'agent', input.agentId].join(':')

/**
 * The DM between one person and one shared agent, created if it is not there.
 *
 * Deliberately does no permission work: both callers have already decided the
 * person may address this agent, and duplicating that decision here would make
 * two answers to one question.
 */
export const ensureSharedAgentDm = async (
  prisma: TransactionClient,
  input: {
    agentId: string
    agentName: string
    organizationId: string
    projectId: string
    teamId: string
    userId: string
  },
): Promise<string> => {
  const dmKey = agentDmKey(input)
  let channel: { id: string }
  try {
    channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        dmKey,
        label: input.agentName,
        organizationId: input.organizationId,
        projectId: input.projectId,
        teamId: input.teamId,
        type: 'dm',
        visibility: 'private',
        members: { create: { userId: input.userId, role: 'owner' } },
      },
      update: {},
      select: { id: true },
    })
  } catch (error) {
    // Two callers can reach the same new DM at once — a wake racing the person
    // opening it. The upsert is not atomic against that, so the loser re-reads
    // rather than failing a notification pass that had nothing wrong with it.
    if (!isUniqueConstraintError(error)) throw error
    channel = await prisma.channel.findUniqueOrThrow({ where: { dmKey }, select: { id: true } })
  }
  await prisma.agentBinding.createMany({
    data: [{ agentId: input.agentId, channelId: channel.id }],
    skipDuplicates: true,
  })
  return channel.id
}

export type AgentConversationTarget = { channelId: string; threadId: string }

/**
 * The thread a board watcher's wake lands in.
 *
 * Returns null rather than inventing a home for an agent that has none: a
 * system-managed agent and the personal assistant own no automation at all
 * (`createAgentTrigger` refuses both for the same reason), so a watcher naming
 * one could never be delivered. The watcher routes refuse it at the point it is
 * added, which is where a person can still do something about it.
 */
export const resolveAgentConversation = async (
  prisma: TransactionClient,
  input: {
    agentId: string
    organizationId: string
    /** Whose DM to use for a shared agent — the person who added the watcher. */
    onBehalfOfUserId: string
    /**
     * The team whose DM this is. Supplied by the caller's session, never worked
     * out here: `agentDmKey` includes it, and the interactive route takes it
     * from the session — so a second rule for the same key would open a second
     * DM for the same pair, and the wake would post into the one nobody opens.
     */
    teamId: string
  },
): Promise<AgentConversationTarget | null> => {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, organizationId: input.organizationId },
    select: {
      id: true,
      name: true,
      agentKind: true,
      systemManaged: true,
      systemSlug: true,
      visibility: true,
      ownerUserId: true,
      projectId: true,
    },
  })
  if (!agent) return null
  if (agent.systemManaged || agent.systemSlug || agent.agentKind === 'personal_assistant') {
    return null
  }

  // A private agent's home was provisioned with it and belongs to its owner —
  // not to whoever put it on a watch list. Waking it anywhere else would be a
  // second home for an agent that has one.
  if (agent.visibility === 'private') {
    if (!agent.ownerUserId) return null
    const dmKey = privateAgentHomeDmKey({
      agentId: agent.id,
      organizationId: input.organizationId,
      ownerUserId: agent.ownerUserId,
    })
    const home = await prisma.channel.findUnique({ where: { dmKey }, select: { id: true } })
    // Re-provision rather than refuse: an agent that predates the home
    // provisioner still has an owner and a team, and the ensure is idempotent.
    if (!home) return null
    return { channelId: home.id, threadId: await ensureDefaultThread(prisma, home.id) }
  }

  const team = await prisma.team.findFirst({
    where: { id: input.teamId, project: { organizationId: input.organizationId } },
    select: { projectId: true },
  })
  if (!team) return null

  const channelId = await ensureSharedAgentDm(prisma, {
    agentId: agent.id,
    agentName: agent.name,
    organizationId: input.organizationId,
    projectId: team.projectId,
    teamId: input.teamId,
    userId: input.onBehalfOfUserId,
  })
  return { channelId, threadId: await ensureDefaultThread(prisma, channelId) }
}

