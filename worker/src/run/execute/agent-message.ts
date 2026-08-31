import type { MessageRole, Prisma, PrismaClient } from '@prisma/client'
import { computeReplyBasis, type BasisScope } from './disclosure-basis.js'
import type { RunContext } from './types.js'

/**
 * The one place a message carrying a *run's own words* is written.
 *
 * This docstring used to claim nine call sites all routed through here, and none
 * of them audited it; four did not. The scope is narrower than "every agent
 * message" and stating it precisely is the point, because the boundary only
 * holds where content actually derives from a run's context:
 *
 * **Routes through here** — the normal reply and its delegated-PA branch
 * (`completion.ts`), cancellation partial text (`cancel-stop.ts`), failure
 * notices (`failure.ts`), budget notices (`budget-gate.ts`), and the rolling
 * watch status (`watch-status.ts`, both its create and its in-place edit).
 * These are the paths where the model's words leave a run.
 *
 * **Deliberately outside, because there is nothing to stamp** — server-authored
 * fixed copy that no model produced and no context informed: the pre-run budget
 * block notice (`orchestrate.ts`), the comms connect card (`comms-card.ts`), the
 * trigger kickoff directive (`trigger-run.ts`, a `system` row excluded from the
 * feed), and workflow run-status cards (`workflow-run-events.ts`, template copy
 * keyed by status). An empty basis is the correct answer for these, not a
 * missing one.
 *
 * **Outside and correct for its own reason** — external-agent replies
 * (`external-conversation.ts`) run no Nessie inference, so the content never
 * passed through a run's context and consumed nothing. `send_message`
 * (`pa-tools/message-delivery.ts`) computes its own destination-specific basis
 * because it posts into a *different* surface than the run is replying to.
 *
 * **Known gaps, not yet closed** — agent-to-agent mailbox delivery
 * (`control/mailbox.ts`) and workflow step messages
 * (`control/workflow-message-send.ts`) carry content authored by *another* run
 * and do not propagate that run's basis, because neither the mailbox row nor the
 * workflow step carries one to propagate.
 *
 * A message and its basis rows commit together — `inTransaction` guarantees that
 * here rather than relying on each caller to pass a transaction, which is how it
 * came to be false for four of them.
 */

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Run `work` inside a transaction, opening one if the caller did not.
 *
 * The atomicity this file promises was only ever true for the callers that
 * happened to pass a transaction — four of the five passed `deps.prisma`, so the
 * message row and its basis rows were two independent writes. A crash between
 * them leaves a message with no basis, and no basis means *unrestricted*: the
 * failure mode of a half-written stamp is publication, not an error. The
 * guarantee therefore belongs to the chokepoint rather than to each caller
 * remembering.
 */
const inTransaction = async <T>(tx: Tx, work: (inner: Tx) => Promise<T>): Promise<T> =>
  '$transaction' in tx ? tx.$transaction((inner) => work(inner)) : work(tx)

/**
 * The scope chain of the surface a run is replying into. Both write paths below
 * and the live-stream gate must ask the same question of the same destination,
 * so the chain is built once rather than restated at each call.
 */
const destinationFor = (context: RunContext) => ({
  channelId: context.channel.id,
  organizationId: context.channel.organizationId,
  projectId: context.channel.projectId,
  teamId: context.channel.teamId,
})

/**
 * Whether what this run has consumed *so far* would restrict its reply.
 *
 * The sink is additive and the destination is fixed, so this is monotone: once
 * true it stays true for the life of the run. That is what makes it usable as a
 * live-stream gate — text already published was produced before any restricted
 * source entered the context and therefore cannot be derived from one, while
 * everything after the flip is withheld until the finished message is read
 * through the disclosure predicate.
 */
export const runReplyBasis = (context: RunContext): BasisScope[] =>
  computeReplyBasis(context.consumedSources.list(), destinationFor(context))

export const runReplyIsRestricted = (context: RunContext): boolean =>
  runReplyBasis(context).length > 0

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
  const basis = runReplyBasis(context)

  return inTransaction(tx, async (inner) => {
    const message = await inner.message.create({
      data: {
        content: draft.content,
        role: draft.role,
        threadId: draft.threadId,
        ...(draft.agentId ? { agentId: draft.agentId } : {}),
        ...(context.run.principalUserId
          ? { onBehalfOfUserId: context.run.principalUserId }
          : {}),
        ...(draft.userId ? { userId: draft.userId } : {}),
        ...(draft.rootMessageId ? { rootMessageId: draft.rootMessageId } : {}),
        ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
      },
      select: { id: true, createdAt: true, threadId: true, content: true, role: true },
    })

    await insertBasisScopes(inner, {
      basis,
      messageId: message.id,
      organizationId: context.channel.organizationId,
    })
    await persistRunBasis(inner, {
      basis,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

    return { ...message, basis }
  })
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
  input: {
    messageId: string
    content: string
    /** Written alongside the content; the rolling watch counter rides here. */
    metadata?: Prisma.InputJsonValue
    /** Caller-supplied edit time, so a caller that reports it can report the stored value. */
    editedAt?: Date
  },
): Promise<BasisScope[]> => {
  const basis = runReplyBasis(context)

  return inTransaction(tx, async (inner) => {
    await inner.message.update({
      data: {
        content: input.content,
        editedAt: input.editedAt ?? new Date(),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      where: { id: input.messageId },
    })

    await insertBasisScopes(inner, {
      basis,
      messageId: input.messageId,
      organizationId: context.channel.organizationId,
    })
    await persistRunBasis(inner, {
      basis,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

    return basis
  })
}
