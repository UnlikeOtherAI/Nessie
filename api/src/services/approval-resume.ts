import { Prisma, type PrismaClient } from '@prisma/client'
import { drainPendingThreadMessagesBestEffort, isThreadRunSlotBusy } from '@nessie/db'
import { applyReplyBookkeeping } from '@nessie/runtime'
import {
  AuthorizedActionContextSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
} from '@nessie/schemas'
import { z } from 'zod'
import { enqueueRunExecution } from '../queue/pgqueue.js'

const ApprovalResumeStateSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  args: z.record(z.unknown()),
  interactive: z.boolean(),
  messageId: z.string().min(1),
}).strict()

type ResumeFailure = 'already_resumed' | 'busy' | 'invalid_resume_state' | 'run_not_waiting'

class ResumeRollback extends Error {
  constructor(readonly reason: ResumeFailure) {
    super(reason)
  }
}

const updateApprovalGateNoticeStatus = async (
  tx: Prisma.TransactionClient,
  input: {
    approvalId: string
    status: 'approved' | 'cancelled' | 'expired' | 'rejected'
    threadId: string
  },
): Promise<void> => {
  const notice = await tx.message.findFirst({
    where: {
      metadata: { equals: input.approvalId, path: ['approvalGate', 'approvalId'] },
      threadId: input.threadId,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, metadata: true },
  })
  if (!notice || !notice.metadata || Array.isArray(notice.metadata)) return
  const approvalGate = (notice.metadata as Record<string, unknown>)['approvalGate']
  if (!approvalGate || typeof approvalGate !== 'object' || Array.isArray(approvalGate)) return
  await tx.message.update({
    where: { id: notice.id },
    data: {
      metadata: {
        ...(notice.metadata as Record<string, unknown>),
        approvalGate: {
          ...(approvalGate as Record<string, unknown>),
          status: input.status,
        },
      } as Prisma.InputJsonValue,
    },
  })
}

export type ResumeApprovalResult =
  | { kind: 'resumed'; runId: string; taskId: string }
  | { kind: ResumeFailure }

/**
 * Create the one fresh run that may consume a tool-gate checkpoint. The
 * suspended row is terminalized inside the same advisory-locked transaction
 * before the slot probe, so its own `waiting_approval` state cannot deadlock
 * its continuation.
 */
export const resumeRunFromApproval = async (
  prisma: PrismaClient,
  approvalId: string,
): Promise<ResumeApprovalResult> => {
  try {
    return await prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.findFirst({
        where: { action: 'tool.invoke', id: approvalId, status: 'approved' },
        select: {
          continuationToken: true,
          id: true,
          organizationId: true,
          resumeState: true,
          runId: true,
        },
      })
      if (!approval?.runId) throw new ResumeRollback('invalid_resume_state')
      const resumeState = ApprovalResumeStateSchema.safeParse(approval.resumeState)
      if (!resumeState.success || resumeState.data.actorContext.tenant.organizationId !== approval.organizationId) {
        throw new ResumeRollback('invalid_resume_state')
      }

      const run = await tx.run.findFirst({
        where: { id: approval.runId, thread: { channel: { organizationId: approval.organizationId } } },
        select: {
          agentId: true,
          principalUserId: true,
          replyPlacement: true,
          replyRootMessageId: true,
          thread: { select: { channelId: true } },
          threadId: true,
          triggerMessageId: true,
        },
      })
      if (!run || !run.triggerMessageId || run.triggerMessageId !== resumeState.data.messageId) {
        throw new ResumeRollback('invalid_resume_state')
      }
      const message = await tx.message.findUnique({
        where: { id: resumeState.data.messageId },
        select: { content: true, id: true },
      })
      if (!message) throw new ResumeRollback('invalid_resume_state')

      const terminalized = await tx.run.updateMany({
        where: { id: approval.runId, status: 'waiting_approval' },
        data: { finishedAt: new Date(), status: 'completed' },
      })
      if (terminalized.count !== 1) throw new ResumeRollback('run_not_waiting')
      await updateApprovalGateNoticeStatus(tx, {
        approvalId: approval.id,
        status: 'approved',
        threadId: run.threadId,
      })

      if (await isThreadRunSlotBusy(tx, {
        agentId: run.agentId,
        ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
        threadId: run.threadId,
      })) {
        throw new ResumeRollback('busy')
      }
      const checkpoint = await tx.runCheckpoint.findUnique({
        where: { runId: approval.runId },
        select: { id: true, consumedByRunId: true },
      })
      if (!checkpoint || checkpoint.consumedByRunId !== null) {
        throw new ResumeRollback('already_resumed')
      }

      const continuation = await tx.run.create({
        data: {
          agentId: run.agentId,
          continuationOfRunId: approval.runId,
          principalUserId: run.principalUserId,
          replyPlacement: run.replyPlacement,
          status: 'pending',
          threadId: run.threadId,
          triggerMessageId: message.id,
        },
        select: { id: true },
      })
      const claimed = await tx.runCheckpoint.updateMany({
        where: { consumedByRunId: null, id: checkpoint.id },
        data: { consumedAt: new Date(), consumedByRunId: continuation.id },
      })
      if (claimed.count !== 1) throw new ResumeRollback('already_resumed')

      const task = await tx.task.create({
        data: {
          agentId: run.agentId,
          organizationId: approval.organizationId,
          purpose: message.content.slice(0, 200),
          runId: continuation.id,
          status: 'inbox',
        },
        select: { id: true },
      })
      await tx.taskEvent.create({
        data: {
          eventType: 'run.continued',
          payload: {
            auto: false,
            continuationOfRunId: approval.runId,
            fromApprovalId: approval.id,
            fromCheckpointId: checkpoint.id,
            runId: continuation.id,
          },
          taskId: task.id,
        },
      })
      const actorContext = AuthorizedActionContextSchema.parse({
        ...withActionContext(resumeState.data.actorContext, {
          agentId: parseAgentId(run.agentId),
          channelId: parseChannelId(run.thread.channelId),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(run.threadId),
        }),
        approval: {
          approvalId: approval.id,
          approvalProof: approval.continuationToken,
        },
      })
      const queued = await enqueueRunExecution(tx, {
        actorContext,
        agentId: parseAgentId(run.agentId),
        ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
        interactive: resumeState.data.interactive,
        messageId: message.id,
        runId: parseRunId(continuation.id),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(run.threadId),
      }, `run:approval:${continuation.id}`)
      if (!queued) throw new Error('Approval continuation enqueue conflict')
      return { kind: 'resumed' as const, runId: continuation.id, taskId: task.id }
    })
  } catch (error) {
    if (error instanceof ResumeRollback) return { kind: error.reason }
    throw error
  }
}

type TerminalApprovalOutcome = 'rejected' | 'expired'

/** Close a waiting approval without consuming its checkpoint, leaving a plain reply able to resume it. */
const terminalizeWaitingApprovalRun = async (
  prisma: PrismaClient,
  approvalId: string,
  outcome: TerminalApprovalOutcome,
): Promise<boolean> => {
  const result = await prisma.$transaction(async (tx) => {
    const approval = await tx.approvalRequest.findFirst({
      where: { action: 'tool.invoke', id: approvalId },
      select: { agentId: true, id: true, organizationId: true, runId: true, toolName: true },
    })
    if (!approval?.runId || !approval.toolName) return null
    const run = await tx.run.findFirst({
      where: { id: approval.runId, thread: { channel: { organizationId: approval.organizationId } } },
      select: { agentId: true, principalUserId: true, replyRootMessageId: true, threadId: true },
    })
    if (!run) return null
    const status = outcome === 'rejected' ? 'completed' : 'failed'
    const taskStatus = outcome === 'rejected' ? 'done' : 'failed'
    const changed = await tx.run.updateMany({
      where: { id: approval.runId, status: 'waiting_approval' },
      data: { finishedAt: new Date(), status },
    })
    if (changed.count !== 1) return null
    await updateApprovalGateNoticeStatus(tx, {
      approvalId: approval.id,
      status: outcome,
      threadId: run.threadId,
    })

    const content = outcome === 'rejected'
      ? `Approval was declined for ${approval.toolName}. Reply to continue without that action.`
      : `Approval expired for ${approval.toolName}. Reply to try again.`
    const message = await tx.message.create({
      data: {
        agentId: run.agentId,
        content,
        metadata: {
          approvalGate: {
            approvalId: approval.id,
            runId: approval.runId,
            status: outcome,
            toolName: approval.toolName,
          },
        } as Prisma.InputJsonValue,
        ...(run.principalUserId ? { onBehalfOfUserId: run.principalUserId } : {}),
        role: 'assistant',
        threadId: run.threadId,
        ...(run.replyRootMessageId ? { rootMessageId: run.replyRootMessageId } : {}),
      },
      select: { createdAt: true, id: true },
    })
    const basis = await tx.runBasisScope.findMany({
      where: { runId: approval.runId },
      select: { scopeId: true, scopeType: true },
    })
    if (basis.length > 0) {
      await tx.messageBasisScope.createMany({
        data: basis.map((scope) => ({
          messageId: message.id,
          organizationId: approval.organizationId,
          scopeId: scope.scopeId,
          scopeType: scope.scopeType,
        })),
        skipDuplicates: true,
      })
    }
    if (run.replyRootMessageId) {
      await applyReplyBookkeeping(tx, {
        authorId: run.agentId,
        replyCreatedAt: message.createdAt,
        rootMessageId: run.replyRootMessageId,
      })
    }
    await tx.task.updateMany({ where: { runId: approval.runId }, data: { status: taskStatus } })
    const task = await tx.task.findFirst({ where: { runId: approval.runId }, select: { id: true } })
    if (task) {
      await tx.taskEvent.create({
        data: {
          eventType: outcome === 'rejected' ? 'run.approval_rejected' : 'run.approval_expired',
          payload: { approvalId: approval.id, runId: approval.runId, toolName: approval.toolName },
          taskId: task.id,
        },
      })
    }
    await tx.agent.updateMany({
      where: { id: approval.agentId, status: 'waiting_approval' },
      data: { status: 'idle' },
    })
    return { agentId: run.agentId, principalUserId: run.principalUserId, threadId: run.threadId }
  })
  if (!result) return false
  // The status transition occurred outside a worker, so proactively schedule
  // the existing durable pending-message drain rather than leaving it to its sweep.
  await drainPendingThreadMessagesBestEffort(prisma, {
    agentId: result.agentId,
    ...(result.principalUserId ? { principalUserId: result.principalUserId } : {}),
    threadId: result.threadId,
  })
  return true
}

export const terminalizeRejectedToolApproval = async (
  prisma: PrismaClient,
  approvalId: string,
): Promise<boolean> => terminalizeWaitingApprovalRun(prisma, approvalId, 'rejected')

export const terminalizeExpiredToolApproval = async (
  prisma: PrismaClient,
  approvalId: string,
): Promise<boolean> => terminalizeWaitingApprovalRun(prisma, approvalId, 'expired')

/** A cancelled suspended run must not leave an actionable approval behind. */
export const expirePendingToolApprovalsForRun = async (
  prisma: PrismaClient,
  runId: string,
): Promise<void> => {
  const approvals = await prisma.approvalRequest.findMany({
    where: { action: 'tool.invoke', runId, status: 'pending' },
    select: { agentId: true, id: true, organizationId: true, toolName: true },
  })
  if (approvals.length === 0) return
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { agentId: true, principalUserId: true, replyRootMessageId: true, threadId: true },
  })
  if (!run) return
  const expired = await prisma.$transaction(async (tx) => {
    const basis = await tx.runBasisScope.findMany({
      where: { runId },
      select: { scopeId: true, scopeType: true },
    })
    const claimed: string[] = []
    for (const approval of approvals) {
      const update = await tx.approvalRequest.updateMany({
        where: { id: approval.id, status: 'pending' },
        data: { status: 'expired' },
      })
      if (update.count !== 1) continue
      claimed.push(approval.id)
      await updateApprovalGateNoticeStatus(tx, {
        approvalId: approval.id,
        status: 'cancelled',
        threadId: run.threadId,
      })
      const message = await tx.message.create({
        data: {
          agentId: run.agentId,
          content: `The run was cancelled before ${approval.toolName ?? 'this tool'} could be approved.`,
          metadata: {
            approvalGate: {
              approvalId: approval.id,
              runId,
              status: 'cancelled',
              toolName: approval.toolName,
            },
          } as Prisma.InputJsonValue,
          ...(run.principalUserId ? { onBehalfOfUserId: run.principalUserId } : {}),
          role: 'assistant',
          threadId: run.threadId,
          ...(run.replyRootMessageId ? { rootMessageId: run.replyRootMessageId } : {}),
        },
        select: { createdAt: true, id: true },
      })
      if (basis.length > 0) {
        await tx.messageBasisScope.createMany({
          data: basis.map((scope) => ({
            messageId: message.id,
            organizationId: approval.organizationId,
            scopeId: scope.scopeId,
            scopeType: scope.scopeType,
          })),
          skipDuplicates: true,
        })
      }
      if (run.replyRootMessageId) {
        await applyReplyBookkeeping(tx, {
          authorId: run.agentId,
          replyCreatedAt: message.createdAt,
          rootMessageId: run.replyRootMessageId,
        })
      }
      await tx.agent.updateMany({
        where: { id: approval.agentId, status: 'waiting_approval' },
        data: { status: 'idle' },
      })
    }
    return claimed
  })
  if (expired.length > 0) {
    await drainPendingThreadMessagesBestEffort(prisma, {
      agentId: run.agentId,
      ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })
  }
}
