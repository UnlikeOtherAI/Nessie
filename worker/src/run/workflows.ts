import { Prisma, type PrismaClient } from '@prisma/client'

type WorkflowStepDefinition = {
  id: string
  input?: Record<string, unknown>
  title?: string
  type: string
}

type WorkflowGraph = {
  steps: WorkflowStepDefinition[]
}

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

const normalizeJsonInput = (value: Record<string, unknown> | undefined): Prisma.InputJsonValue =>
  (value ?? {}) as Prisma.InputJsonValue

export const mergeStepRunOutput = (
  existing: unknown,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return {
      ...(existing as Record<string, unknown>),
      ...(incoming ?? {}),
    }
  }
  return incoming ?? {}
}

export type WorkflowStepFinishTransition = {
  continueWorkflow: boolean
  nextRunStatus: 'completed' | 'failed' | 'running'
  nextStepStatus: 'completed' | 'failed'
  workflowRunCompleted: boolean
}

export const computeWorkflowStepFinishTransition = (input: {
  remainingSteps: number
  success: boolean
}): WorkflowStepFinishTransition => {
  const nextStepStatus: 'completed' | 'failed' = input.success ? 'completed' : 'failed'
  const nextRunStatus: 'completed' | 'failed' | 'running' = !input.success
    ? 'failed'
    : input.remainingSteps > 0
      ? 'running'
      : 'completed'

  return {
    continueWorkflow: input.success && input.remainingSteps > 0,
    nextRunStatus,
    nextStepStatus,
    workflowRunCompleted: input.success && input.remainingSteps === 0,
  }
}

export const ensureWorkflowStepRuns = async (
  prisma: PrismaLike,
  input: {
    steps: WorkflowGraph['steps']
    workflowRunId: string
  },
): Promise<void> =>
  withTransaction(prisma, async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.workflowRunId}),
        hashtext('workflow_steps')
      )
    `

    const existing = await tx.workflowStepRun.findMany({
      where: { workflowRunId: input.workflowRunId },
      select: { sequence: true, stepKey: true },
    })
    const existingBySequence = new Set(existing.map((entry) => `${entry.sequence}:${entry.stepKey}`))

    for (const [index, step] of input.steps.entries()) {
      const key = `${index}:${step.id}`
      if (existingBySequence.has(key)) {
        continue
      }

      await tx.workflowStepRun.create({
        data: {
          workflowRunId: input.workflowRunId,
          stepKey: step.id,
          stepType: step.type,
          title: (step.title?.trim() || step.id).slice(0, 120),
          sequence: index,
          status: 'pending',
          input: normalizeJsonInput(step.input),
        },
      })
    }
  })

export const loadWorkflowGraph = async (
  prisma: PrismaLike,
  workflowRunId: string,
): Promise<{
  graph: WorkflowGraph
  installation: {
    channelId: string | null
    config: unknown
    id: string
    projectId: string | null
    resolvedBindings: unknown
    teamId: string | null
    workflowTemplateId: string
    workflowTemplateVersion: number
  }
  run: {
    id: string
    installationId: string
    input: unknown
    organizationId: string
    startedByActorId: string
    startedByActorType: string
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  }
} | null> => {
  const workflowRun = await prisma.workflowRun.findUnique({
    where: { id: workflowRunId },
    select: {
      id: true,
      installationId: true,
      input: true,
      organizationId: true,
      startedByActorId: true,
      startedByActorType: true,
      status: true,
      installation: {
        select: {
          channelId: true,
          config: true,
          id: true,
          projectId: true,
          resolvedBindings: true,
          teamId: true,
          workflowTemplateId: true,
          workflowTemplateVersion: true,
          workflowTemplate: {
            select: {
              graphJson: true,
            },
          },
        },
      },
    },
  })

  if (!workflowRun) {
    return null
  }

  const graphJson =
    workflowRun.installation.workflowTemplate.graphJson &&
    typeof workflowRun.installation.workflowTemplate.graphJson === 'object' &&
    !Array.isArray(workflowRun.installation.workflowTemplate.graphJson)
      ? workflowRun.installation.workflowTemplate.graphJson
      : {}

  const rawSteps = (graphJson as Record<string, unknown>)['steps']
  const steps: unknown[] = Array.isArray(rawSteps) ? rawSteps : []
  const graph: WorkflowGraph = {
    steps: steps
      .map((step): WorkflowStepDefinition | null => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          return null
        }
        const record = step as Record<string, unknown>
        if (typeof record['id'] !== 'string' || typeof record['type'] !== 'string') {
          return null
        }
        return {
          id: record['id'],
          type: record['type'],
          title: typeof record['title'] === 'string' ? record['title'] : undefined,
          input:
            record['input'] && typeof record['input'] === 'object' && !Array.isArray(record['input'])
              ? (record['input'] as Record<string, unknown>)
              : undefined,
        }
      })
      .filter((step): step is WorkflowStepDefinition => step !== null),
  }

  return {
    graph,
    installation: {
      channelId: workflowRun.installation.channelId,
      config: workflowRun.installation.config,
      id: workflowRun.installation.id,
      projectId: workflowRun.installation.projectId,
      resolvedBindings: workflowRun.installation.resolvedBindings,
      teamId: workflowRun.installation.teamId,
      workflowTemplateId: workflowRun.installation.workflowTemplateId,
      workflowTemplateVersion: workflowRun.installation.workflowTemplateVersion,
    },
    run: {
      id: workflowRun.id,
      installationId: workflowRun.installationId,
      input: workflowRun.input,
      organizationId: workflowRun.organizationId,
      startedByActorId: workflowRun.startedByActorId,
      startedByActorType: workflowRun.startedByActorType,
      status: workflowRun.status,
    },
  }
}

export const listWorkflowStepRuns = async (
  prisma: PrismaLike,
  workflowRunId: string,
) =>
  prisma.workflowStepRun.findMany({
    where: { workflowRunId },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  })

export const markWorkflowRunStarted = async (
  prisma: PrismaLike,
  workflowRunId: string,
): Promise<void> => {
  await prisma.workflowRun.update({
    where: { id: workflowRunId },
    data: {
      status: 'running',
      startedAt: new Date(),
    },
  })
}

export const markWorkflowStepRunStarted = async (
  prisma: PrismaLike,
  input: {
    input?: Record<string, unknown>
    output?: Record<string, unknown>
    stepRunId: string
  },
): Promise<void> => {
  await prisma.workflowStepRun.update({
    where: { id: input.stepRunId },
    data: {
      status: 'running',
      startedAt: new Date(),
      ...(input.input ? { input: input.input as Prisma.InputJsonValue } : {}),
      ...(input.output ? { output: input.output as Prisma.InputJsonValue } : {}),
    },
  })
}

export const markWorkflowStepRunQueued = async (
  prisma: PrismaLike,
  input: {
    input?: Record<string, unknown>
    output?: Record<string, unknown>
    workflowRunId?: string | null
    workflowStepRunId?: string | null
  },
): Promise<void> => {
  if (!input.workflowRunId || !input.workflowStepRunId) {
    return
  }

  const workflowRunId = input.workflowRunId
  const workflowStepRunId = input.workflowStepRunId

  await withTransaction(prisma, async (tx) => {
    const now = new Date()
    const existingRun = await tx.workflowRun.findUnique({
      where: { id: workflowRunId },
      select: { startedAt: true },
    })

    await tx.workflowStepRun.update({
      where: { id: workflowStepRunId },
      data: {
        status: 'running',
        startedAt: now,
        ...(input.input ? { input: input.input as Prisma.InputJsonValue } : {}),
        ...(input.output ? { output: input.output as Prisma.InputJsonValue } : {}),
      },
    })
    await tx.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: 'running',
        ...(existingRun?.startedAt ? {} : { startedAt: now }),
      },
    })
  })
}

export const attachWorkflowStepRunArtifacts = async (
  prisma: PrismaLike,
  input: {
    output: Record<string, unknown>
    stepRunId: string
  },
): Promise<void> => {
  const existing = await prisma.workflowStepRun.findUnique({
    where: { id: input.stepRunId },
    select: { output: true },
  })

  const nextOutput =
    existing?.output && typeof existing.output === 'object' && !Array.isArray(existing.output)
      ? {
          ...(existing.output as Record<string, unknown>),
          ...input.output,
        }
      : input.output

  await prisma.workflowStepRun.update({
    where: { id: input.stepRunId },
    data: {
      output: nextOutput as Prisma.InputJsonValue,
    },
  })
}

export const markWorkflowStepRunFinished = async (
  prisma: PrismaLike,
  input: {
    output?: Record<string, unknown>
    stepRunId?: string | null
    success: boolean
    summary?: string
    workflowRunId?: string | null
  },
): Promise<{ continueWorkflow: boolean; workflowRunCompleted: boolean }> => {
  if (!input.workflowRunId || !input.stepRunId) {
    return {
      continueWorkflow: false,
      workflowRunCompleted: false,
    }
  }
  const workflowRunId = input.workflowRunId
  const stepRunId = input.stepRunId

  return withTransaction(prisma, async (tx) => {
    const existing = await tx.workflowStepRun.findUnique({
      where: { id: stepRunId },
      select: {
        output: true,
        workflowRunId: true,
      },
    })
    if (!existing || existing.workflowRunId !== workflowRunId) {
      return {
        continueWorkflow: false,
        workflowRunCompleted: false,
      }
    }

    const mergedOutput = mergeStepRunOutput(existing.output, input.output)

    const remainingBeforeUpdate = await tx.workflowStepRun.count({
      where: {
        workflowRunId,
        id: { not: stepRunId },
        status: {
          in: ['pending', 'running', 'blocked'],
        },
      },
    })

    const transition = computeWorkflowStepFinishTransition({
      remainingSteps: remainingBeforeUpdate,
      success: input.success,
    })

    await tx.workflowStepRun.update({
      where: { id: stepRunId },
      data: {
        status: transition.nextStepStatus,
        output: mergedOutput as Prisma.InputJsonValue,
        errorMessage: input.success ? null : input.summary,
        finishedAt: new Date(),
      },
    })

    await tx.workflowRun.update({
      where: { id: workflowRunId },
      data: {
        status: transition.nextRunStatus,
        summary: input.summary,
        ...(transition.nextRunStatus === 'completed' || transition.nextRunStatus === 'failed'
          ? { finishedAt: new Date() }
          : {}),
      },
    })

    return {
      continueWorkflow: transition.continueWorkflow,
      workflowRunCompleted: transition.workflowRunCompleted,
    }
  })
}

export const markWorkflowRunFinished = async (
  prisma: PrismaLike,
  input: {
    output?: Record<string, unknown>
    success: boolean
    summary?: string
    workflowRunId: string
  },
): Promise<void> => {
  await prisma.workflowRun.update({
    where: { id: input.workflowRunId },
    data: {
      status: input.success ? 'completed' : 'failed',
      output: (input.output ?? {}) as Prisma.InputJsonValue,
      summary: input.summary,
      errorMessage: input.success ? null : input.summary,
      finishedAt: new Date(),
    },
  })
}
