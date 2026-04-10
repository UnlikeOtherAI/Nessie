import { Prisma, type PrismaClient } from '@prisma/client'

type RunPlanContext = {
  planId: string
  rootStepId: string
}

const ROOT_STEP_SEQUENCE = 0

type PrismaLike = PrismaClient | Prisma.TransactionClient

const withTransaction = async <T>(
  prisma: PrismaLike,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if ('$transaction' in prisma) {
    return prisma.$transaction((tx) => work(tx))
  }

  return work(prisma)
}

export const ensureRunPlanContext = async (
  prisma: PrismaLike,
  input: {
    agentId: string
    channelId: string
    createdByActorId: string
    createdByActorType: string
    goal: string
    organizationId: string
    runId: string
  },
): Promise<RunPlanContext> =>
  withTransaction(prisma, async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.runId}),
        hashtext('run_plan')
      )
    `

    const plan =
      (await tx.plan.findFirst({
        where: {
          organizationId: input.organizationId,
          runId: input.runId,
        },
        select: { id: true },
      })) ??
      (await tx.plan.create({
        data: {
          agentId: input.agentId,
          channelId: input.channelId,
          createdByActorId: input.createdByActorId,
          createdByActorType: input.createdByActorType,
          goal: input.goal,
          organizationId: input.organizationId,
          runId: input.runId,
          status: 'draft',
        },
        select: { id: true },
      }))

    const rootStep =
      (await tx.planStep.findFirst({
        where: {
          planId: plan.id,
          sequence: ROOT_STEP_SEQUENCE,
        },
        select: { id: true },
      })) ??
      (await tx.planStep.create({
        data: {
          artifacts: {} as Prisma.InputJsonValue,
          payload: {
            prompt: input.goal,
          } as Prisma.InputJsonValue,
          planId: plan.id,
          sequence: ROOT_STEP_SEQUENCE,
          status: 'pending',
          title: input.goal.slice(0, 120),
          type: 'message',
        },
        select: { id: true },
      }))

    return {
      planId: plan.id,
      rootStepId: rootStep.id,
    }
  })

export const markRunPlanStarted = async (
  prisma: PrismaLike,
  input: RunPlanContext,
): Promise<void> => {
  await prisma.plan.update({
    where: { id: input.planId },
    data: { status: 'active' },
  })
  await prisma.planStep.update({
    where: { id: input.rootStepId },
    data: { status: 'running' },
  })
}

const computePlanTerminalStatus = async (
  prisma: PrismaLike,
  input: {
    excludeStepId: string
    planId: string
    success: boolean
  },
): Promise<'completed' | 'failed' | 'waiting'> => {
  if (!input.success) {
    return 'failed'
  }

  const remaining = await prisma.planStep.count({
    where: {
      id: { not: input.excludeStepId },
      planId: input.planId,
      status: {
        in: ['pending', 'running', 'blocked'],
      },
    },
  })

  return remaining > 0 ? 'waiting' : 'completed'
}

export const markRunPlanFinished = async (
  prisma: PrismaLike,
  input: RunPlanContext & {
    artifacts?: Record<string, unknown>
    summary?: string
    success: boolean
  },
): Promise<void> => {
  const planStatus = await computePlanTerminalStatus(prisma, {
    excludeStepId: input.rootStepId,
    planId: input.planId,
    success: input.success,
  })

  await prisma.plan.update({
    where: { id: input.planId },
    data: {
      status: planStatus,
      summary: input.summary,
    },
  })
  await prisma.planStep.update({
    where: { id: input.rootStepId },
    data: {
      artifacts: (input.artifacts ?? {}) as Prisma.InputJsonValue,
      status: input.success ? 'completed' : 'failed',
    },
  })
}

export const appendDelegationStep = async (
  prisma: PrismaLike,
  input: {
    assignedAgentId: string
    planId: string
    payload: Record<string, unknown>
    title: string
  },
): Promise<{ stepId: string }> =>
  withTransaction(prisma, async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.planId}),
        hashtext('plan_steps')
      )
    `

    const nextSequence =
      (((await tx.planStep.aggregate({
        where: { planId: input.planId },
        _max: { sequence: true },
      }))._max.sequence ?? ROOT_STEP_SEQUENCE) + 1)

    const step = await tx.planStep.create({
      data: {
        assignedAgentId: input.assignedAgentId,
        payload: input.payload as Prisma.InputJsonValue,
        planId: input.planId,
        sequence: nextSequence,
        status: 'pending',
        title: input.title.slice(0, 120),
        type: 'spawn_task',
      },
      select: { id: true },
    })

    await tx.plan.update({
      where: { id: input.planId },
      data: { status: 'waiting' },
    })

    return { stepId: step.id }
  })

export const markDelegationStepQueued = async (
  prisma: PrismaLike,
  input: {
    artifacts: Record<string, unknown>
    planId?: string | null
    planStepId?: string | null
  },
): Promise<void> => {
  if (!input.planId || !input.planStepId) {
    return
  }

  await prisma.planStep.update({
    where: { id: input.planStepId },
    data: {
      artifacts: input.artifacts as Prisma.InputJsonValue,
      status: 'running',
    },
  })
  await prisma.plan.update({
    where: { id: input.planId },
    data: { status: 'waiting' },
  })
}

export const markDelegationStepFinished = async (
  prisma: PrismaLike,
  input: {
    artifacts?: Record<string, unknown>
    planId?: string | null
    planStepId?: string | null
    success: boolean
    summary?: string
  },
): Promise<void> => {
  if (!input.planId || !input.planStepId) {
    return
  }

  const existingStep = await prisma.planStep.findUnique({
    where: { id: input.planStepId },
    select: {
      artifacts: true,
      id: true,
      planId: true,
    },
  })
  if (!existingStep || existingStep.planId !== input.planId) {
    return
  }

  const mergedArtifacts =
    existingStep.artifacts &&
    typeof existingStep.artifacts === 'object' &&
    !Array.isArray(existingStep.artifacts)
      ? {
          ...(existingStep.artifacts as Record<string, unknown>),
          ...(input.artifacts ?? {}),
        }
      : (input.artifacts ?? {})

  const planStatus = await computePlanTerminalStatus(prisma, {
    excludeStepId: input.planStepId,
    planId: input.planId,
    success: input.success,
  })

  await prisma.planStep.update({
    where: { id: input.planStepId },
    data: {
      artifacts: mergedArtifacts as Prisma.InputJsonValue,
      status: input.success ? 'completed' : 'failed',
    },
  })

  await prisma.plan.update({
    where: { id: input.planId },
    data: {
      status: planStatus,
      ...(input.summary ? { summary: input.summary } : {}),
    },
  })
}
