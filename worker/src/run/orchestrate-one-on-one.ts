import { Prisma, type PrismaClient } from '@prisma/client'
import {
  attributionFromActorContext,
  judgeOneOnOneTurn,
  partitionByDisclosure,
  type DecisionModelClient,
  type OneOnOneEarlierMessage,
  type OneOnOneJudgement,
  type OrchestratorDecision,
} from '@nessie/runtime'
import {
  ChannelDecisionSnapshotSchema,
  ONE_ON_ONE_DECISION_FINGERPRINT,
  type OrchestrateDecideJobPayload,
} from '@nessie/schemas'

import { conversationTurnLineage } from './execute/private-conversation-lineage.js'
import type { ChannelAgent } from './orchestrate-candidates.js'
import { loadAttachmentAnnotator, resolveDecisionViewer } from './orchestrate-context.js'

/**
 * One-on-one rooms (docs/standards/reply-threads.md → "One-on-one rooms").
 *
 * Reply threads keep an exchange from interrupting the other people in a room.
 * A room whose only person is the one talking has nobody to interrupt, so its
 * answers belong in the main chat — and when that room also has exactly one
 * agent, every message is addressed to it, so Jev decides *how* the agent
 * answers rather than whether it does. All of it is keyed on structure — the
 * channel's type, its member count, its agent bindings — never on what a
 * message says.
 */

/** A DM whose only member is the person talking. */
export const isSinglePersonRoom = (channel: { type: string; memberCount: number }): boolean =>
  channel.type === 'dm' && channel.memberCount === 1

/**
 * A single-person room with exactly one agent. An external-agent DM is excluded:
 * its every turn is proxied to its own product, so Nessie never gives it a
 * reply shape or skips a turn with a reaction.
 */
export const isOneOnOneAgentRoom = (
  channel: { memberCount: number; systemChannelType: string | null; type: string },
  channelAgents: readonly unknown[],
): boolean =>
  isSinglePersonRoom(channel)
  && channel.systemChannelType !== 'external_agent'
  && channelAgents.length === 1

/**
 * The fallback placement when Jev did not judge the turn: a top-level turn in
 * a single-person room is answered in the main chat. A turn written inside a
 * reply thread is not passed through here — it continues in its thread, which
 * `resolveReplyRootMessageId` decides structurally before any placement.
 */
export const answerInMainChat = (decisions: OrchestratorDecision[]): OrchestratorDecision[] =>
  decisions.map((decision) =>
    decision.action === 'reply' ? { ...decision, replyPlacement: 'channel' } : decision)

/** How many earlier top-level messages Jev may choose between. */
const MAX_EARLIER_MESSAGES = 12
/**
 * The turns immediately above the latest message are the exchange it carries
 * on from; "going back" means further up. Positional, so nothing is read to
 * decide it.
 */
const IMMEDIATE_EXCHANGE = 2
const CONTEXT_TURNS = 5
/**
 * Jev only refines an answer that is owed anyway, so a slow classifier costs
 * the person seconds, never the answer: past this the room's structural
 * answer goes ahead.
 */
const JEV_TIMEOUT_MS = 4_000

type OneOnOneTrigger = {
  channelDecision: unknown
  createdAt: Date
  id: string
  rootMessageId: string | null
}

const uniqueByValue = <T>(values: readonly T[]): T[] =>
  [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]

/**
 * What Jev reads: the main chat's top-level turns for a top-level message, or
 * the reply thread a threaded message sits in — through the person's own
 * visibility, and admitted into the snapshot's lineage exactly as the
 * transcript would admit them, so whatever the run later derives from the
 * judgement keeps their provenance.
 */
const loadOneOnOneWindow = async (
  prisma: PrismaClient,
  input: {
    channel: { organizationId: string; visibility: string }
    payload: OrchestrateDecideJobPayload
    trigger: OneOnOneTrigger
  },
) => {
  const { channel, payload, trigger } = input
  const rows = await prisma.message.findMany({
    where: {
      threadId: payload.threadId,
      id: { not: trigger.id },
      role: { in: ['user', 'assistant'] },
      deletedAt: null,
      createdAt: { lte: trigger.createdAt },
      ...(trigger.rootMessageId
        ? { OR: [{ id: trigger.rootMessageId }, { rootMessageId: trigger.rootMessageId }] }
        : { rootMessageId: null }),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_EARLIER_MESSAGES + IMMEDIATE_EXCHANGE,
    include: {
      agent: { select: { name: true } },
      basisScopes: { select: { scopeType: true, scopeId: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
    },
  })
  const viewer = await resolveDecisionViewer(prisma, payload.actorContext, channel.organizationId)
  const visible = partitionByDisclosure(rows, viewer).visible.reverse()
  const annotate = await loadAttachmentAnnotator(
    prisma,
    channel.organizationId,
    [...visible.map((message) => message.id), trigger.id],
  )
  const lineage = visible.map((message) =>
    conversationTurnLineage(message, { id: payload.channelId, visibility: channel.visibility }))
  const earlierMessages: OneOnOneEarlierMessage[] = trigger.rootMessageId
    ? []
    : visible.slice(0, Math.max(0, visible.length - IMMEDIATE_EXCHANGE)).map((message) => ({
        id: message.id,
        author: message.role === 'user' ? 'person' : 'agent',
        content: annotate(message.content, message.id),
      }))
  return {
    basisScopes: uniqueByValue(lineage.flatMap((entry) => entry.basisScopes)),
    content: annotate(payload.content, trigger.id),
    disclosureSources: uniqueByValue(lineage.flatMap((entry) => entry.disclosureSources)),
    earlierMessages,
    recentMessages: visible.slice(-CONTEXT_TURNS).map((message) => ({
      role: message.role,
      content: annotate(message.content, message.id),
      ...(message.agent ? { agentName: message.agent.name } : {}),
    })),
  }
}

const decisionsFor = (
  judgement: OneOnOneJudgement,
  agent: ChannelAgent,
  trigger: OneOnOneTrigger,
): OrchestratorDecision[] => {
  const identity = {
    agentId: agent.id,
    ...(agent.principalUserId ? { principalUserId: agent.principalUserId } : {}),
  }
  if (judgement.shape === 'acknowledge') {
    return [{ action: 'acknowledge', ...identity, emoji: judgement.emoji }]
  }
  const earlier = judgement.earlier
  const threaded = trigger.rootMessageId !== null || earlier?.reference === 'thread'
  return [{
    action: 'reply',
    ...identity,
    replyPlacement: threaded ? 'thread' : 'channel',
    ...(earlier ? { earlierMessageId: earlier.messageId, earlierReference: earlier.reference } : {}),
    ...(judgement.shape === 'act' ? { acknowledgeWhenDone: true } : {}),
  }]
}

/**
 * The saved decisions that still name this room's one agent, or null to fall
 * back. Only a one-on-one judgement is read back here: a channel policy's
 * snapshot carries configured work and its author's authority, which a DM
 * must never pick up by accident.
 */
const addressedTo = (agent: ChannelAgent, snapshot: unknown): OrchestratorDecision[] | null => {
  const saved = ChannelDecisionSnapshotSchema.safeParse(snapshot)
  if (!saved.success || saved.data.policyFingerprint !== ONE_ON_ONE_DECISION_FINGERPRINT) return null
  const decisions = saved.data.decisions.filter((decision) =>
    decision.action !== 'none'
    && decision.agentId === agent.id
    && decision.principalUserId === agent.principalUserId)
  return decisions.length > 0 ? decisions : null
}

/**
 * Jev's judgement of one human turn in a one-on-one room, pinned to the message
 * the first time it is made so a redelivered decide job reads it back instead
 * of judging again.
 *
 * Returns null whenever there is no judgement to act on — no Ledger evaluation
 * client, an evaluation that failed or timed out, a saved decision that no
 * longer names the room's agent — and the caller answers the way the room
 * always has, in the main chat. Nothing is posted about it: a notice on every
 * message of a private chat would be worse than the plain answer it replaces.
 */
export const decideOneOnOneTurn = async (
  deps: { decisionClient?: DecisionModelClient; prisma: PrismaClient },
  input: {
    agent: ChannelAgent
    channel: { organizationId: string; visibility: string }
    payload: OrchestrateDecideJobPayload
    trigger: OneOnOneTrigger
  },
): Promise<OrchestratorDecision[] | null> => {
  const { agent, payload, trigger } = input
  if (trigger.channelDecision != null) return addressedTo(agent, trigger.channelDecision)
  if (!deps.decisionClient) return null

  const window = await loadOneOnOneWindow(deps.prisma, input)
  let judged: Awaited<ReturnType<typeof judgeOneOnOneTurn>>
  try {
    judged = await judgeOneOnOneTurn(deps.decisionClient, {
      agent,
      content: window.content,
      earlierMessages: window.earlierMessages,
      recentMessages: window.recentMessages,
      timeoutMs: JEV_TIMEOUT_MS,
      usage: attributionFromActorContext(payload.actorContext, {
        systemComponent: 'one-on-one-replies',
      }),
    })
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'orchestrate.one_on_one.unjudged',
      messageId: trigger.id,
      reason: error instanceof Error ? error.message : String(error),
    }))
    return null
  }

  const snapshot = {
    policyFingerprint: ONE_ON_ONE_DECISION_FINGERPRINT,
    authorizer: null,
    basisScopes: window.basisScopes,
    choices: judged.choices,
    decisions: decisionsFor(judged.judgement, agent, trigger),
    disclosureSources: window.disclosureSources,
  }
  const claimed = await deps.prisma.message.updateMany({
    where: { id: trigger.id, channelDecision: { equals: Prisma.DbNull } },
    data: { channelDecision: snapshot as Prisma.InputJsonValue },
  })
  if (claimed.count === 1) return snapshot.decisions
  // A concurrent delivery pinned its judgement first; that one is the answer.
  const winner = await deps.prisma.message.findUniqueOrThrow({
    where: { id: trigger.id },
    select: { channelDecision: true },
  })
  return addressedTo(agent, winner.channelDecision)
}
