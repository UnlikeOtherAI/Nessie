import type { Prisma } from '@prisma/client'
import {
  applyReplyBookkeeping,
  followReplyThread,
  insertMessageBasis,
  insertMessageDisclosureSources,
  type BasisScopeRow,
  type MessagePrivateConversationSource,
  type ReplyRootMetadata,
} from '@nessie/runtime'
import type { MessageRole } from '@nessie/schemas'

import { messageInclude, type MessageWithReactions } from './message-include.js'

/**
 * Messages the *server* authors — a product handoff prompt, a mirrored
 * external-agent turn, an executor launch notice, a card press.
 *
 * Deliberately its own module beside `message-create.ts` rather than a mode of
 * `createThreadMessage`: a person's send carries an idempotency key, structured
 * mention validation, durable mention alerts and the "also send to #channel"
 * copy, none of which a server-authored row has any use for. Keeping the two
 * doors apart is what makes a tenth `message.create` have to answer which one
 * it is, instead of quietly becoming a ninth hand-rolled copy.
 */

/** The fields a server-authored message row is written from. */
export type SystemAuthoredMessageInput = {
  agentId?: string | null
  /**
   * The disclosure the content needs, stamped on the row in this transaction:
   * the basis scopes it may be shown under, and the private conversations it
   * carries words from. A server-authored message that relays gathered content
   * (a DeepWater research result, its wake kickoff) must never be readable by
   * anyone its sources are not; one that relays nothing leaves both empty.
   */
  basisScopes?: readonly BasisScopeRow[]
  content: string
  disclosureSources?: readonly MessagePrivateConversationSource[]
  /** Backdated only when mirroring history that already happened elsewhere. */
  createdAt?: Date
  followedByUserIds: string[]
  metadata?: Prisma.InputJsonValue
  /** The principal an agent is speaking for — a PA shared-channel presence. */
  onBehalfOfUserId?: string | null
  role: MessageRole
  threadId: string
  userId?: string | null
}

/**
 * A server-authored row is never a person's composer send, whoever it is
 * written for, so `metadata.authorship` (`PERSON_MESSAGE_AUTHORSHIP`) is
 * dropped from whatever metadata a caller relays — mirrored external text or
 * a card press cannot pass as the person having typed it.
 */
const withoutPersonAuthorship = (
  metadata: Prisma.InputJsonValue | undefined,
): Prisma.InputJsonValue | undefined => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('authorship' in metadata)) {
    return metadata
  }
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key !== 'authorship'),
  ) as Prisma.InputJsonValue
}

const writeSystemAuthoredRow = async (
  tx: Prisma.TransactionClient,
  input: SystemAuthoredMessageInput & { rootMessageId?: string },
): Promise<MessageWithReactions> => {
  const created = await tx.message.create({
    data: {
      content: input.content,
      role: input.role,
      threadId: input.threadId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.metadata === undefined ? {} : { metadata: withoutPersonAuthorship(input.metadata) }),
      ...(input.onBehalfOfUserId ? { onBehalfOfUserId: input.onBehalfOfUserId } : {}),
      ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    include: messageInclude,
  })
  const basis = input.basisScopes ?? []
  const sources = input.disclosureSources ?? []
  if (basis.length === 0 && sources.length === 0) return created
  const { organizationId } = await tx.thread.findUniqueOrThrow({
    where: { id: input.threadId },
    select: { channel: { select: { organizationId: true } } },
  }).then((thread) => thread.channel)
  await insertMessageBasis(tx, { messageId: created.id, organizationId, basis })
  await insertMessageDisclosureSources(tx, { messageId: created.id, organizationId, sources })
  // Re-read so the returned row carries the basis it was written with.
  return tx.message.findUniqueOrThrow({ where: { id: created.id }, include: messageInclude })
}

/**
 * A message the server authors on someone's behalf — a product handoff prompt,
 * a mirrored external-agent turn.
 *
 * This is deliberately **not** `createThreadMessage`, and deliberately named so
 * that adding a tenth `message.create` has to answer why it is neither. What it
 * keeps is the invariant a message in a reply-threaded product cannot be
 * without: the people who are participating follow the reply conversation it
 * starts, so the assistant's answer reaches their Threads inbox. The caller
 * names them, because "who participated" is the one thing only the caller
 * knows — a live handoff is its requester; a mirrored page of past history is
 * nobody, and auto-following two hundred imported turns would bury the inbox
 * it is supposed to serve.
 *
 * What it deliberately skips, and why:
 *  - **idempotency by `clientMessageId`** — every caller already has a stronger
 *    key of its own (a claimed enqueue slot, an external turn id).
 *  - **structured agent-mention validation** — the content is server-authored
 *    or already-published external text, not a client's claim about identities.
 *  - **`metadata.mentions` resolution and durable mention alerts** — nobody is
 *    being @mentioned by the server, so there is nothing to highlight and
 *    nobody to alert.
 *  - **the "also send to #channel" copy** — there is no reply to broadcast.
 *
 * Announcement, push and orchestration stay with the caller exactly as they do
 * for `createThreadMessage` — see `message-delivery.ts`.
 */
export const createSystemAuthoredMessage = async (
  tx: Prisma.TransactionClient,
  input: SystemAuthoredMessageInput,
): Promise<MessageWithReactions> => {
  const created = await writeSystemAuthoredRow(tx, input)
  await followReplyThread(tx, {
    rootMessageId: created.id,
    userIds: input.followedByUserIds,
  })
  return created
}

/**
 * The same message, posted *into* an existing reply thread rather than opening
 * one.
 *
 * Separated from `createSystemAuthoredMessage` because a reply owes the root
 * one thing a top-level post does not: the materialized `replyCount` /
 * `lastReplyAt` / `replyParticipantIds` bookkeeping
 * ([docs/standards/reply-threads.md](../../../docs/standards/reply-threads.md)),
 * applied in the same transaction as the row so concurrent replies cannot lose
 * a count. `authorId` is who the root records as having participated — the
 * agent for an agent's notice, the person for a card press.
 *
 * `followedByUserIds` follows the *root*, not this reply: participate-to-follow
 * is a property of the conversation, and a server-authored notice usually adds
 * nobody, because the people who owe it an answer already follow.
 */
export const createSystemAuthoredReply = async (
  tx: Prisma.TransactionClient,
  input: SystemAuthoredMessageInput & { authorId: string | null; rootMessageId: string },
): Promise<{ message: MessageWithReactions; replyMetadata: ReplyRootMetadata }> => {
  const created = await writeSystemAuthoredRow(tx, input)
  const replyMetadata = await applyReplyBookkeeping(tx, {
    authorId: input.authorId,
    replyCreatedAt: created.createdAt,
    rootMessageId: input.rootMessageId,
  })
  await followReplyThread(tx, {
    rootMessageId: input.rootMessageId,
    userIds: input.followedByUserIds,
  })
  return { message: created, replyMetadata }
}
