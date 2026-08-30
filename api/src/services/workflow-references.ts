import type { Prisma, PrismaClient } from '@prisma/client'

// Every "does this row exist, inside the caller's organization?" check the
// workflow services make before a write. Separate from workflow-validation.ts,
// which judges the authored graph without touching foreign rows: these are the
// tenancy-boundary lookups, and each one owns the exact error code its route
// maps to.

export const validateRequiredEnvironmentTemplateIds = async (
  prisma: PrismaClient,
  organizationId: string,
  templateIds: string[],
): Promise<void> => {
  if (templateIds.length === 0) {
    return
  }

  const count = await prisma.executionEnvironmentTemplate.count({
    where: {
      id: {
        in: templateIds,
      },
      organizationId,
    },
  })

  if (count !== templateIds.length) {
    throw new Error('WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND')
  }
}

export const validateWorkflowInstallationChannel = async (
  prisma: PrismaClient,
  organizationId: string,
  channelId?: string,
): Promise<void> => {
  if (!channelId) {
    return
  }

  const channel = await prisma.channel.findFirst({
    where: {
      id: channelId,
      organizationId,
      systemChannelType: null,
    },
    select: { id: true },
  })

  if (!channel) {
    throw new Error('WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')
  }
}

export const validateWorkflowRunReferences = async (
  prisma: Prisma.TransactionClient,
  organizationId: string,
  input: {
    originChannelId?: string
    originMessageId?: string
    originThreadId?: string
    parentRunId?: string
    planId?: string
    planStepId?: string
    replyRootMessageId?: string
    triggerDeliveryId?: string
    triggerId?: string
  },
): Promise<void> => {
  // W25 origin references: the caller may point a run at where it was asked
  // for, but never across an organization boundary.
  if (input.originChannelId) {
    const channel = await prisma.channel.findFirst({
      where: { id: input.originChannelId, organizationId },
      select: { id: true },
    })
    if (!channel) {
      throw new Error('WORKFLOW_RUN_ORIGIN_CHANNEL_NOT_FOUND')
    }
  }

  if (input.originThreadId) {
    const thread = await prisma.thread.findFirst({
      where: {
        id: input.originThreadId,
        channel: { organizationId },
      },
      select: { channelId: true },
    })
    if (!thread) {
      throw new Error('WORKFLOW_RUN_ORIGIN_THREAD_NOT_FOUND')
    }
    if (input.originChannelId && thread.channelId !== input.originChannelId) {
      throw new Error('WORKFLOW_RUN_ORIGIN_THREAD_MISMATCH')
    }
  }

  if (input.originMessageId ?? input.replyRootMessageId) {
    for (const messageId of [input.originMessageId, input.replyRootMessageId]) {
      if (!messageId) continue
      const message = await prisma.message.findFirst({
        where: {
          id: messageId,
          thread: { channel: { organizationId } },
        },
        select: { threadId: true },
      })
      if (!message) {
        throw new Error('WORKFLOW_RUN_ORIGIN_MESSAGE_NOT_FOUND')
      }
      if (input.originThreadId && message.threadId !== input.originThreadId) {
        throw new Error('WORKFLOW_RUN_ORIGIN_MESSAGE_MISMATCH')
      }
    }
  }

  if (input.triggerId) {
    const trigger = await prisma.agentTrigger.findFirst({
      where: {
        id: input.triggerId,
        agent: {
          organizationId,
        },
      },
      select: { id: true },
    })
    if (!trigger) {
      throw new Error('WORKFLOW_RUN_TRIGGER_NOT_FOUND')
    }
  }

  if (input.triggerDeliveryId) {
    const delivery = await prisma.agentTriggerDelivery.findFirst({
      where: {
        id: input.triggerDeliveryId,
        trigger: {
          agent: {
            organizationId,
          },
        },
      },
      select: {
        triggerId: true,
      },
    })
    if (!delivery) {
      throw new Error('WORKFLOW_RUN_TRIGGER_DELIVERY_NOT_FOUND')
    }
    if (input.triggerId && delivery.triggerId !== input.triggerId) {
      throw new Error('WORKFLOW_RUN_TRIGGER_DELIVERY_MISMATCH')
    }
  }

  if (input.parentRunId) {
    const parentRun = await prisma.run.findFirst({
      where: {
        id: input.parentRunId,
        thread: {
          channel: {
            organizationId,
          },
        },
      },
      select: { id: true },
    })
    if (!parentRun) {
      throw new Error('WORKFLOW_RUN_PARENT_RUN_NOT_FOUND')
    }
  }

  if (input.planId) {
    const plan = await prisma.plan.findFirst({
      where: {
        id: input.planId,
        organizationId,
      },
      select: { id: true },
    })
    if (!plan) {
      throw new Error('WORKFLOW_RUN_PLAN_NOT_FOUND')
    }
  }

  if (input.planStepId) {
    const planStep = await prisma.planStep.findFirst({
      where: {
        id: input.planStepId,
      },
      select: {
        planId: true,
      },
    })
    if (!planStep) {
      throw new Error('WORKFLOW_RUN_PLAN_STEP_NOT_FOUND')
    }
    const plan = await prisma.plan.findFirst({
      where: {
        id: planStep.planId,
        organizationId,
      },
      select: {
        id: true,
      },
    })
    if (!plan) {
      throw new Error('WORKFLOW_RUN_PLAN_STEP_NOT_FOUND')
    }
    if (input.planId && planStep.planId !== input.planId) {
      throw new Error('WORKFLOW_RUN_PLAN_STEP_MISMATCH')
    }
  }
}
