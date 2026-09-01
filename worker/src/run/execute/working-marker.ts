import { parseAgentId } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import type { PgRealtimeTransport } from '@nessie/runtime'

/**
 * "I'm looking at this" — an agent reaction on the message a run is working
 * from.
 *
 * The thinking bubble already signals activity, but only in the composer and
 * only while somebody is watching. A reaction sits on the message itself, so
 * anyone scrolling back can see which message an agent picked up — the way a
 * colleague glancing at your message reads.
 *
 * The working marker is owned by the run, never the model: its presence is a
 * structural fact ("a run for this message is in flight"), not a judgement,
 * and a model cannot clean up after a crash. Removal is fused to the terminal
 * status transition rather than to any one happy path, so completion, failure,
 * budget stop and cancellation all clear it without knowing they do.
 */

export const WORKING_EMOJI = '👀'

export const publishReactionChanged = async (
  transport: PgRealtimeTransport,
  input: {
    agentId: string
    emoji: string
    messageId: string
    onBehalfOfUserId?: string
    threadId: string
  },
): Promise<void> => {
  await transport.publishSse(input.threadId, 'message.reaction', {
    agentId: parseAgentId(input.agentId),
    emoji: input.emoji,
    messageId: input.messageId,
    ...(input.onBehalfOfUserId ? { onBehalfOfUserId: input.onBehalfOfUserId } : {}),
  })
}

type ReactionPrisma = Pick<PrismaClient, 'messageReaction'>

/**
 * Put the agent's reaction on a message, replacing any it already had there.
 * Used for both the working marker and an emoji-only reply.
 */
export const setAgentReaction = async (
  prisma: ReactionPrisma,
  input: { agentId: string; emoji: string; messageId: string; onBehalfOfUserId?: string },
): Promise<void> => {
  await prisma.messageReaction.createMany({
    data: [{
      agentId: input.agentId,
      emoji: input.emoji,
      messageId: input.messageId,
      onBehalfOfUserId: input.onBehalfOfUserId ?? null,
    }],
    skipDuplicates: true,
  })
}

/**
 * Mark the message this run is working from.
 *
 * Also clears any working marker this agent stranded elsewhere in the thread.
 * The queue re-delivers a crashed run and its eventual terminal transition
 * removes the marker, so this is belt-and-braces rather than the mechanism —
 * but it means a marker can never accumulate. Never throws: a decoration must
 * not be able to fail a run.
 */
export const markWorking = async (
  prisma: ReactionPrisma,
  transport: PgRealtimeTransport,
  input: {
    agentId: string
    messageId: string | null
    onBehalfOfUserId?: string
    threadId: string
  },
): Promise<void> => {
  if (!input.messageId) return
  try {
    const stale = await prisma.messageReaction.findMany({
      select: { messageId: true },
      where: {
        agentId: input.agentId,
        emoji: WORKING_EMOJI,
        onBehalfOfUserId: input.onBehalfOfUserId ?? null,
        message: { threadId: input.threadId },
        messageId: { not: input.messageId },
      },
    })
    if (stale.length > 0) {
      await prisma.messageReaction.deleteMany({
        where: {
          agentId: input.agentId,
          emoji: WORKING_EMOJI,
          messageId: { in: stale.map((row) => row.messageId) },
          onBehalfOfUserId: input.onBehalfOfUserId ?? null,
        },
      })
      for (const row of stale) {
        await publishReactionChanged(transport, {
          agentId: input.agentId,
          emoji: WORKING_EMOJI,
          messageId: row.messageId,
          ...(input.onBehalfOfUserId
            ? { onBehalfOfUserId: input.onBehalfOfUserId }
            : {}),
          threadId: input.threadId,
        })
      }
    }

    await setAgentReaction(prisma, {
      agentId: input.agentId,
      emoji: WORKING_EMOJI,
      messageId: input.messageId,
      ...(input.onBehalfOfUserId
        ? { onBehalfOfUserId: input.onBehalfOfUserId }
        : {}),
    })
    await publishReactionChanged(transport, {
      agentId: input.agentId,
      emoji: WORKING_EMOJI,
      messageId: input.messageId,
      ...(input.onBehalfOfUserId
        ? { onBehalfOfUserId: input.onBehalfOfUserId }
        : {}),
      threadId: input.threadId,
    })
  } catch (error) {
    console.warn('[worker] could not mark working reaction', error)
  }
}

/**
 * Drop the working marker. Idempotent and unconditional, so the terminal
 * transition can call it without knowing whether one was ever painted.
 */
export const clearWorking = async (
  prisma: ReactionPrisma,
  transport: PgRealtimeTransport | null,
  input: {
    agentId: string
    messageId: string | null
    onBehalfOfUserId?: string
    threadId: string
  },
): Promise<void> => {
  if (!input.messageId) return
  try {
    const { count } = await prisma.messageReaction.deleteMany({
      where: {
        agentId: input.agentId,
        emoji: WORKING_EMOJI,
        messageId: input.messageId,
        onBehalfOfUserId: input.onBehalfOfUserId ?? null,
      },
    })
    if (count > 0 && transport) {
      await publishReactionChanged(transport, {
        agentId: input.agentId,
        emoji: WORKING_EMOJI,
        messageId: input.messageId,
        ...(input.onBehalfOfUserId
          ? { onBehalfOfUserId: input.onBehalfOfUserId }
          : {}),
        threadId: input.threadId,
      })
    }
  } catch (error) {
    console.warn('[worker] could not clear working reaction', error)
  }
}

/**
 * Did this run already say everything it had to say with a reaction?
 *
 * The `react` tool is meant to be used *instead of* replying, but a model that
 * reacts often also emits a token or two of final text — and the terminal path
 * posts whatever it emits, so a 👍 chip arrived alongside a message whose
 * entire content was "👍". Two ways of saying the same thing, one of them the
 * exact emoji-rendered-as-text this was built to avoid.
 *
 * The primary signal is structural: the run called `react`. The text check is
 * only a guard on top of that — it asks whether the words carry any
 * information at all, not what they mean. Anything with a letter or a digit in
 * it is a real message and gets posted; a bare emoji, or punctuation, does not.
 * Deliberately not a judgement about intent, which stays the model's.
 */
export const isContentlessAfterReacting = (
  reacted: boolean,
  responseText: string,
): boolean => reacted && !/[\p{L}\p{N}]/u.test(responseText)
