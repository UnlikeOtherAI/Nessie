import type { Prisma, PrismaClient } from '@prisma/client'
import type { ApprovalCardPlacement, ApprovalGateMetadata } from '@nessie/schemas'

import { ensureDefaultThread } from './channel-records.js'
import { createSystemAuthoredMessage } from './system-authored-message.js'

type TransactionClient = PrismaClient | Prisma.TransactionClient

/**
 * An approval is answered in a conversation, and in no other kind of place.
 *
 * There is no approvals page behind this. The card written here is the whole
 * surface, which is why every path that opens an approval writes one and why
 * this module — rather than each caller — decides where it goes.
 *
 * **The originating thread is already the requester's thread.** A sub-agent run
 * (`worker/src/run/subtask-tools.ts`) and a peer delegation
 * (`worker/src/run/pa-tools/peer-delegation.ts`) are both created on their
 * parent's `threadId` rather than in a conversation of their own, so a card
 * posted to the run's thread surfaces in the conversation where a person made
 * the original ask. Nothing walks a delegation chain because nothing has to.
 *
 * **Some approvers cannot see that thread.** An owner-gated proposal
 * (`requiredApproverRole: 'owner'`) is raised in whatever channel the agent was
 * working in, and an organisation owner is not automatically a member of it; a
 * paired MCP credential has no channel at all. Those approvers get the same
 * card in their own Personal Assistant conversation. Without this they would
 * have nowhere to answer and the request would expire unseen — the failure
 * `worker/src/run/pa-tools/todos.ts` already records against the old page.
 */

/** The channel that is a person's own Personal Assistant conversation. */
export const personalAssistantDmKey = (input: {
  organizationId: string
  userId: string
}): string => `pa:${input.organizationId}:${input.userId}`

export type ApprovalCardTarget = {
  /** Carried so the caller can announce the card on that channel's scopes. */
  channelId: string
  placement: ApprovalCardPlacement
  systemChannelType: string | null
  threadId: string
  /** The approver this copy is for; null for the copy everyone in the room sees. */
  userId: string | null
}

const canReadChannel = async (
  tx: TransactionClient,
  input: { channelId: string; userId: string },
): Promise<boolean> => {
  const channel = await tx.channel.findFirst({
    select: {
      members: { select: { id: true }, take: 1, where: { userId: input.userId } },
      visibility: true,
    },
    where: { id: input.channelId },
  })
  return Boolean(channel && (channel.visibility === 'public' || channel.members.length > 0))
}

const personalAssistantTarget = async (
  tx: TransactionClient,
  input: { organizationId: string; userId: string },
): Promise<Omit<ApprovalCardTarget, 'placement' | 'userId'> | null> => {
  const channel = await tx.channel.findFirst({
    select: { id: true, systemChannelType: true },
    where: { dmKey: personalAssistantDmKey(input), organizationId: input.organizationId },
  })
  // Read-only on purpose: every person who has signed in has this conversation
  // (it is what bootstrap lands on), and an approval is not a reason to
  // provision one for somebody who has never opened the product.
  if (!channel) return null
  return {
    channelId: channel.id,
    systemChannelType: channel.systemChannelType ?? null,
    threadId: await ensureDefaultThread(tx, channel.id),
  }
}

/**
 * Every conversation this approval has to appear in.
 *
 * `approverUserIds` is what `createApprovalUserAlerts` returned — the people
 * the server already decided must answer. An approver who can read the
 * originating channel needs no second copy: the card is already in front of
 * them.
 */
export const resolveApprovalCardTargets = async (
  tx: TransactionClient,
  input: {
    approverUserIds: string[]
    organizationId: string
    originChannelId: string | null
    originSystemChannelType?: string | null
    originThreadId: string | null
  },
): Promise<ApprovalCardTarget[]> => {
  const targets: ApprovalCardTarget[] = []
  if (input.originThreadId && input.originChannelId) {
    targets.push({
      channelId: input.originChannelId,
      placement: 'origin',
      systemChannelType: input.originSystemChannelType ?? null,
      threadId: input.originThreadId,
      userId: null,
    })
  }

  for (const userId of input.approverUserIds) {
    if (
      input.originChannelId
      && await canReadChannel(tx, { channelId: input.originChannelId, userId })
    ) {
      continue
    }
    const assistant = await personalAssistantTarget(tx, {
      organizationId: input.organizationId,
      userId,
    })
    // Not the same thread twice: a proposal raised inside somebody's own
    // assistant conversation is already in front of exactly the right person.
    if (assistant && !targets.some((target) => target.threadId === assistant.threadId)) {
      targets.push({ ...assistant, placement: 'assistant', userId })
    }
  }

  return targets
}

/**
 * Write the card. The caller announces it — this module writes rows, exactly as
 * `createSystemAuthoredMessage` does and for the same reason.
 */
export const postApprovalCards = async (
  tx: TransactionClient,
  input: {
    agentId: string | null
    content: string
    gate: ApprovalGateMetadata
    targets: ApprovalCardTarget[]
  },
): Promise<(ApprovalCardTarget & { messageId: string })[]> => {
  const written: (ApprovalCardTarget & { messageId: string })[] = []
  for (const target of input.targets) {
    const message = await createSystemAuthoredMessage(tx as Prisma.TransactionClient, {
      agentId: input.agentId,
      content: input.content,
      followedByUserIds: target.userId ? [target.userId] : [],
      metadata: { approvalGate: input.gate } as Prisma.InputJsonValue,
      role: 'assistant',
      threadId: target.threadId,
    })
    written.push({ ...target, messageId: message.id })
  }
  return written
}

/**
 * Stamp every copy of an approval's card with what was decided.
 *
 * Every copy, not the one in a given thread: the same approval can be waiting
 * in a room and in two owners' assistant conversations, and a card still
 * offering Approve after somebody else answered is a lie about what the button
 * will do.
 */
export const updateApprovalCardsStatus = async (
  tx: TransactionClient,
  input: { approvalId: string; status: ApprovalGateMetadata['status'] },
): Promise<number> => {
  const cards = await tx.message.findMany({
    select: { id: true, metadata: true },
    where: { metadata: { equals: input.approvalId, path: ['approvalGate', 'approvalId'] } },
  })
  let updated = 0
  for (const card of cards) {
    if (!card.metadata || Array.isArray(card.metadata)) continue
    const metadata = card.metadata as Record<string, unknown>
    const gate = metadata['approvalGate']
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) continue
    await tx.message.update({
      data: {
        metadata: {
          ...metadata,
          approvalGate: { ...(gate as Record<string, unknown>), status: input.status },
        } as Prisma.InputJsonValue,
      },
      where: { id: card.id },
    })
    updated += 1
  }
  return updated
}
