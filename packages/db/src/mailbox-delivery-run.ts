import { Prisma } from '@prisma/client'

// The plan or workflow step a mailbox delivery was sent for, and what a
// delivery owes that step once its run exists.
//
// Two paths start a delivery's run: the mailbox dispatcher claiming a free
// thread (`worker/src/control/mailbox.ts`), and the thread drain after the
// delivery pended behind a busy one (`thread-serialization.ts`). Both do
// exactly this, in the same transaction as the run:
//
// - the run's payload names the step. Completion, failure and cancellation
//   finish a plan step and continue a workflow only through
//   `parentPlanId`/`parentPlanStepId` and
//   `parentWorkflowRunId`/`parentWorkflowStepRunId`, so a run without them
//   leaves its step open, and a workflow then waits for the step reaper to
//   fail the step at its deadline however well the agent did the work;
// - the step records the run working it and is `running`. A workflow step's
//   `startedAt` and deadline are the engine's, set when it wrote the mail; a
//   step still `pending` (mail sent straight through `POST /api/mailbox`) gets
//   them now.
//
// A pended delivery can wait a long time, so its workflow or plan may have
// been cancelled meanwhile, closing the step. The step and its parent are then
// left exactly as they are: a delivery never revives cancelled work. The run
// still happens — its mail was delivered — and its completion is already a
// guarded no-op on a closed step.

// A suspended workflow step (agent_task, environment_launch) holds no lease;
// the step reaper reclaims it at this deadline unless the step sets its own
// `timeoutMs`. Here because a delivery can start a step that is still pending.
export const WORKFLOW_STEP_SUSPEND_DEADLINE_MS = 24 * 60 * 60 * 1000

const OPEN_STEP_STATUSES = ['pending', 'running', 'blocked'] as const
const OPEN_PLAN_STATUSES = ['draft', 'active', 'waiting'] as const
const OPEN_WORKFLOW_RUN_STATUSES = ['pending', 'running'] as const

export type MailboxDeliveryStep = {
  planId: string | null
  planStepId: string | null
  subject: string | null
  workflowRunId: string | null
  workflowStepRunId: string | null
}

export const loadMailboxDeliveryStep = (
  tx: Prisma.TransactionClient,
  mailboxMessageId: string,
): Promise<MailboxDeliveryStep> =>
  tx.agentMailboxMessage.findUniqueOrThrow({
    where: { id: mailboxMessageId },
    select: { planId: true, planStepId: true, subject: true, workflowRunId: true, workflowStepRunId: true },
  })

// The run payload fields that link a delivery's run to its step.
export const mailboxDeliveryRunSource = (step: MailboxDeliveryStep) => ({
  ...(step.planId ? { parentPlanId: step.planId } : {}),
  ...(step.planStepId ? { parentPlanStepId: step.planStepId } : {}),
  ...(step.workflowRunId ? { parentWorkflowRunId: step.workflowRunId } : {}),
  ...(step.workflowStepRunId ? { parentWorkflowStepRunId: step.workflowStepRunId } : {}),
})

const asObject = (value: Prisma.JsonValue | null): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const logClosedStep = (kind: 'plan' | 'workflow', input: { mailboxMessageId: string; runId: string }, stepId: string) => {
  console.log(JSON.stringify({
    event: 'mailbox.delivery.step_closed', kind, mailboxMessageId: input.mailboxMessageId, runId: input.runId, stepId,
  }))
}

// Each step marker reads the open step, then writes it with the same status
// guard, then its parent — step before parent, the order the workflow engine
// marks a step queued in. A cancel that lands between the read and the write
// has already closed the step, so the guarded write matches nothing.
const recordPlanStepRun = async (
  tx: Prisma.TransactionClient,
  input: { agentId: string; mailboxMessageId: string; planId: string; planStepId: string; runId: string },
): Promise<void> => {
  const openPlan = await tx.plan.findFirst({
    where: { id: input.planId, status: { in: [...OPEN_PLAN_STATUSES] } },
    select: { id: true },
  })
  const step = openPlan
    ? await tx.planStep.findFirst({
        where: { id: input.planStepId, planId: input.planId, status: { in: [...OPEN_STEP_STATUSES] } },
        select: { artifacts: true },
      })
    : null
  const marked = step
    ? await tx.planStep.updateMany({
        where: { id: input.planStepId, status: { in: [...OPEN_STEP_STATUSES] } },
        data: {
          artifacts: {
            ...asObject(step.artifacts),
            childRunId: input.runId,
            mailboxMessageId: input.mailboxMessageId,
            targetAgentId: input.agentId,
          } as Prisma.InputJsonValue,
          status: 'running',
        },
      })
    : { count: 0 }
  if (marked.count === 0) {
    logClosedStep('plan', input, input.planStepId)
    return
  }
  await tx.plan.updateMany({
    where: { id: input.planId, status: { in: [...OPEN_PLAN_STATUSES] } },
    data: { status: 'waiting' },
  })
}

const recordWorkflowStepRun = async (
  tx: Prisma.TransactionClient,
  input: {
    agentId: string; mailboxMessageId: string; runId: string; taskId: string
    workflowRunId: string; workflowStepRunId: string
  },
): Promise<void> => {
  const open = {
    id: input.workflowStepRunId,
    status: { in: [...OPEN_STEP_STATUSES] },
    workflowRun: { status: { in: [...OPEN_WORKFLOW_RUN_STATUSES] } },
  }
  const step = await tx.workflowStepRun.findFirst({
    where: { ...open, workflowRunId: input.workflowRunId },
    select: { deadlineAt: true, output: true, startedAt: true, workflowRun: { select: { startedAt: true } } },
  })
  const now = new Date()
  const marked = step
    ? await tx.workflowStepRun.updateMany({
        where: open,
        data: {
          status: 'running',
          startedAt: step.startedAt ?? now,
          deadlineAt: step.deadlineAt ?? new Date(now.getTime() + WORKFLOW_STEP_SUSPEND_DEADLINE_MS),
          // A suspended step waits on this run, not on a worker lease.
          leaseOwnerId: null,
          leaseExpiresAt: null,
          output: {
            ...asObject(step.output),
            childRunId: input.runId,
            mailboxMessageId: input.mailboxMessageId,
            targetAgentId: input.agentId,
            taskId: input.taskId,
          } as Prisma.InputJsonValue,
        },
      })
    : { count: 0 }
  if (!step || marked.count === 0) {
    logClosedStep('workflow', input, input.workflowStepRunId)
    return
  }
  await tx.workflowRun.updateMany({
    where: { id: input.workflowRunId, status: { in: [...OPEN_WORKFLOW_RUN_STATUSES] } },
    data: { status: 'running', startedAt: step.workflowRun.startedAt ?? now },
  })
}

// Record the run a delivery started on the step it was sent for.
export const recordMailboxDeliveryRun = async (
  tx: Prisma.TransactionClient,
  input: { agentId: string; mailboxMessageId: string; runId: string; step: MailboxDeliveryStep; taskId: string },
): Promise<void> => {
  const { step, ...run } = input
  if (step.planId && step.planStepId) {
    await recordPlanStepRun(tx, { ...run, planId: step.planId, planStepId: step.planStepId })
  }
  if (step.workflowRunId && step.workflowStepRunId) {
    await recordWorkflowStepRun(tx, {
      ...run, workflowRunId: step.workflowRunId, workflowStepRunId: step.workflowStepRunId,
    })
  }
}
