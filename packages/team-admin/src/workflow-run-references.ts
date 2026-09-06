import type { Prisma } from '@prisma/client'

// The full set of tenancy-boundary reference errors the workflow-authoring
// and workflow-run-start paths can raise, in one typed class so every route
// matches on `.code` (instanceof-checked) instead of a message string that a
// reword could silently turn into an unhandled 500.
export const WORKFLOW_REFERENCE_ERROR_CODES = {
  CHANNEL_NOT_FOUND: 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND',
  TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND: 'WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND',
  RUN_ORIGIN_CHANNEL_NOT_FOUND: 'WORKFLOW_RUN_ORIGIN_CHANNEL_NOT_FOUND',
  RUN_ORIGIN_THREAD_NOT_FOUND: 'WORKFLOW_RUN_ORIGIN_THREAD_NOT_FOUND',
  RUN_ORIGIN_THREAD_MISMATCH: 'WORKFLOW_RUN_ORIGIN_THREAD_MISMATCH',
  RUN_ORIGIN_MESSAGE_NOT_FOUND: 'WORKFLOW_RUN_ORIGIN_MESSAGE_NOT_FOUND',
  RUN_ORIGIN_MESSAGE_MISMATCH: 'WORKFLOW_RUN_ORIGIN_MESSAGE_MISMATCH',
  RUN_TRIGGER_NOT_FOUND: 'WORKFLOW_RUN_TRIGGER_NOT_FOUND',
  RUN_TRIGGER_DELIVERY_NOT_FOUND: 'WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND',
  RUN_TRIGGER_DELIVERY_MISMATCH: 'WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH',
  RUN_PARENT_RUN_NOT_FOUND: 'WORKFLOW_RUN_PARENT_RUN_NOT_FOUND',
  RUN_PLAN_NOT_FOUND: 'WORKFLOW_RUN_PLAN_NOT_FOUND',
  RUN_PLAN_STEP_NOT_FOUND: 'WORKFLOW_RUN_PLAN_STEP_NOT_FOUND',
  RUN_PLAN_STEP_MISMATCH: 'WORKFLOW_RUN_PLAN_STEP_MISMATCH',
} as const

export type WorkflowReferenceErrorCode =
  (typeof WORKFLOW_REFERENCE_ERROR_CODES)[keyof typeof WORKFLOW_REFERENCE_ERROR_CODES]

export class WorkflowReferenceError extends Error {
  override readonly name = 'WorkflowReferenceError'

  constructor(
    public readonly code: WorkflowReferenceErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type WorkflowRunReferenceInput = {
  originChannelId?: string
  originMessageId?: string
  originThreadId?: string
  parentRunId?: string
  planId?: string
  planStepId?: string
  replyRootMessageId?: string
  triggerDeliveryId?: string
  triggerId?: string
}

/**
 * Validate optional workflow-run references under one tenant before the run
 * and its execute job are written. This is shared by the HTTP and PA starts.
 */
export const validateWorkflowRunReferences = async (
  prisma: Prisma.TransactionClient,
  organizationId: string,
  input: WorkflowRunReferenceInput,
): Promise<void> => {
  if (input.originChannelId) {
    const channel = await prisma.channel.findFirst({
      where: { id: input.originChannelId, organizationId },
      select: { id: true },
    })
    if (!channel) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_ORIGIN_CHANNEL_NOT_FOUND,
        'Origin channel not found',
      )
    }
  }

  if (input.originThreadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: input.originThreadId, channel: { organizationId } },
      select: { channelId: true },
    })
    if (!thread) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_ORIGIN_THREAD_NOT_FOUND,
        'Origin thread not found',
      )
    }
    if (input.originChannelId && thread.channelId !== input.originChannelId) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_ORIGIN_THREAD_MISMATCH,
        'Origin thread does not belong to the origin channel',
      )
    }
  }

  for (const messageId of [input.originMessageId, input.replyRootMessageId]) {
    if (!messageId) continue
    const message = await prisma.message.findFirst({
      where: { id: messageId, thread: { channel: { organizationId } } },
      select: { threadId: true },
    })
    if (!message) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_ORIGIN_MESSAGE_NOT_FOUND,
        'Origin message not found',
      )
    }
    if (input.originThreadId && message.threadId !== input.originThreadId) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_ORIGIN_MESSAGE_MISMATCH,
        'Origin message does not belong to the origin thread',
      )
    }
  }

  if (input.triggerId) {
    const trigger = await prisma.agentTrigger.findFirst({
      where: { id: input.triggerId, agent: { organizationId } },
      select: { id: true },
    })
    if (!trigger) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_TRIGGER_NOT_FOUND,
        'Trigger not found',
      )
    }
  }

  if (input.triggerDeliveryId) {
    const delivery = await prisma.agentTriggerDelivery.findFirst({
      where: { id: input.triggerDeliveryId, trigger: { agent: { organizationId } } },
      select: { triggerId: true },
    })
    if (!delivery) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_TRIGGER_DELIVERY_NOT_FOUND,
        'Trigger delivery not found',
      )
    }
    if (input.triggerId && delivery.triggerId !== input.triggerId) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_TRIGGER_DELIVERY_MISMATCH,
        'Trigger delivery does not belong to the requested trigger',
      )
    }
  }

  if (input.parentRunId) {
    const parentRun = await prisma.run.findFirst({
      where: { id: input.parentRunId, thread: { channel: { organizationId } } },
      select: { id: true },
    })
    if (!parentRun) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_PARENT_RUN_NOT_FOUND,
        'Parent run not found',
      )
    }
  }

  if (input.planId) {
    const plan = await prisma.plan.findFirst({
      where: { id: input.planId, organizationId },
      select: { id: true },
    })
    if (!plan) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_NOT_FOUND,
        'Plan not found',
      )
    }
  }

  if (input.planStepId) {
    const planStep = await prisma.planStep.findFirst({
      where: { id: input.planStepId },
      select: { planId: true },
    })
    if (!planStep) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_STEP_NOT_FOUND,
        'Plan step not found',
      )
    }
    const plan = await prisma.plan.findFirst({
      where: { id: planStep.planId, organizationId },
      select: { id: true },
    })
    if (!plan) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_STEP_NOT_FOUND,
        'Plan step not found',
      )
    }
    if (input.planId && planStep.planId !== input.planId) {
      throw new WorkflowReferenceError(
        WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_STEP_MISMATCH,
        'Plan step does not belong to the requested plan',
      )
    }
  }
}
