import type { MessageRole, Prisma, PrismaClient } from '@prisma/client'
import { computeReplyBasis, type BasisScope } from './disclosure-basis.js'
import type { RunContext } from './types.js'

/**
 * The one place an agent-originated message is written.
 *
 * Nessie creates agent-originated messages from nine call sites — the normal
 * reply and its delegated-PA branch, cancellation partial text, failure notices,
 * budget notices, `send_message`, external-conversation replies, comms cards, and
 * agent-to-agent mailbox delivery. Stamping only the first would close the front
 * door and leave eight side doors emitting content drawn from the identical
 * context, so every one of them routes through here.
 *
 * The message row and its basis rows commit together: a message can never exist
 * unstamped, not even for the width of a transaction.
 */

type Tx = Prisma.TransactionClient | PrismaClient

export type AgentMessageDraft = {
  content: string
  threadId: string
  /** Assistant-authored (the usual case) or authored as the delegating user. */
  role: 'assistant' | 'user'
  agentId?: string | null
  userId?: string | null
  rootMessageId?: string | undefined
  metadata?: Prisma.InputJsonValue | undefined
}

export type StampedMessage = {
  id: string
  createdAt: Date
  threadId: string
  content: string
  role: MessageRole
  /** The basis actually written. Empty means the message is unrestricted. */
  basis: BasisScope[]
}

const insertBasisScopes = async (
  tx: Tx,
  input: { messageId: string; organizationId: string; basis: readonly BasisScope[] },
): Promise<void> => {
  if (input.basis.length === 0) {
    return
  }
  await tx.messageBasisScope.createMany({
    data: input.basis.map((scope) => ({
      messageId: input.messageId,
      organizationId: input.organizationId,
      scopeId: scope.scopeId,
      scopeType: scope.scopeType,
    })),
    skipDuplicates: true,
  })
}

/**
 * Persist the run's own basis ledger. Idempotent: a run that stamps twice (a
 * reply plus a later notice) writes the same rows, and `skipDuplicates` plus the
 * `(run_id, scope_type, scope_id)` unique index make the second write a no-op.
 */
export const persistRunBasis = async (
  tx: Tx,
  input: { runId: string; organizationId: string; basis: readonly BasisScope[] },
): Promise<void> => {
  if (input.basis.length === 0) {
    return
  }
  await tx.runBasisScope.createMany({
    data: input.basis.map((scope) => ({
      organizationId: input.organizationId,
      runId: input.runId,
      scopeId: scope.scopeId,
      scopeType: scope.scopeType,
    })),
    skipDuplicates: true,
  })
}

/**
 * Create an agent-originated message, stamped with the run's disclosure basis.
 *
 * `tx` lets a caller that already owns a transaction (mailbox delivery, subtask
 * spawn) join it rather than nesting. Callers keep their own post-commit
 * effects — realtime publication, alerts, status updates — deliberately outside:
 * a listener must never observe an uncommitted message id, and a basis failure
 * must not roll back a run's terminal state.
 */
export const createAgentMessage = async (
  tx: Tx,
  context: RunContext,
  draft: AgentMessageDraft,
): Promise<StampedMessage> => {
  const basis = computeReplyBasis(context.consumedSources.list(), {
    channelId: context.channel.id,
    organizationId: context.channel.organizationId,
    projectId: context.channel.projectId,
    teamId: context.channel.teamId,
  })

  const message = await tx.message.create({
    data: {
      content: draft.content,
      role: draft.role,
      threadId: draft.threadId,
      ...(draft.agentId ? { agentId: draft.agentId } : {}),
      ...(draft.userId ? { userId: draft.userId } : {}),
      ...(draft.rootMessageId ? { rootMessageId: draft.rootMessageId } : {}),
      ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
    },
    select: { id: true, createdAt: true, threadId: true, content: true, role: true },
  })

  await insertBasisScopes(tx, {
    basis,
    messageId: message.id,
    organizationId: context.channel.organizationId,
  })
  await persistRunBasis(tx, {
    basis,
    organizationId: context.channel.organizationId,
    runId: context.run.id,
  })

  return { ...message, basis }
}

/**
 * Replace an existing agent message's content, re-stamping it.
 *
 * Editing is a second write path: `message_edit` and the DeepSignal digest both
 * replace content in place, and an edit that swaps unrestricted text for
 * privileged text must not inherit the original's empty basis. The new basis is
 * the **union** of what is already recorded and the editing run's basis — an
 * edit may narrow what a message says, never relax what it is allowed to say.
 */
export const replaceAgentMessageContent = async (
  tx: Tx,
  context: RunContext,
  input: { messageId: string; content: string },
): Promise<BasisScope[]> => {
  const basis = computeReplyBasis(context.consumedSources.list(), {
    channelId: context.channel.id,
    organizationId: context.channel.organizationId,
    projectId: context.channel.projectId,
    teamId: context.channel.teamId,
  })

  await tx.message.update({
    data: { content: input.content, editedAt: new Date() },
    where: { id: input.messageId },
  })

  await insertBasisScopes(tx, {
    basis,
    messageId: input.messageId,
    organizationId: context.channel.organizationId,
  })
  await persistRunBasis(tx, {
    basis,
    organizationId: context.channel.organizationId,
    runId: context.run.id,
  })

  return basis
}
