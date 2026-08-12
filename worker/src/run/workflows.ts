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
): Promise<{ alreadyMaterialized: boolean }> =>
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

    return { alreadyMaterialized: existing.length > 0 }
  })

// Repairs a drifted run snapshot in place, under the same advisory lock
// ensureWorkflowStepRuns takes, so a repair cannot interleave with step-row
// creation. Used when a run's frozen graph no longer matches its materialized
// step rows — possible only for runs snapshotted while suspended by the
// backfill migration (pre-snapshot rows executing from the live template have
// graph_snapshot NULL and take the fallback path, never this one).
export const reconcileWorkflowRunGraphSnapshot = async (
  prisma: PrismaLike,
  input: {
    graph: WorkflowGraph
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

    const stepRuns = await tx.workflowStepRun.findMany({
      where: { workflowRunId: input.workflowRunId },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true },
    })

    await tx.workflowRun.update({
      where: { id: input.workflowRunId },
      data: { graphSnapshot: input.graph as unknown as Prisma.InputJsonValue },
    })

    // Step rows keep their sequence slots so execution order is untouched;
    // only identity (key/type/title) is re-derived from the drifted template
    // they were actually materialized from.
    for (const stepRun of stepRuns) {
      const step = input.graph.steps[stepRun.sequence]
      if (!step) {
        continue
      }
      await tx.workflowStepRun.update({
        where: { id: stepRun.id },
        data: {
          stepKey: step.id,
          stepType: step.type,
          title: (step.title?.trim() || step.id).slice(0, 120),
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
    pinnedGraphJson: unknown
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
      graphSnapshot: true,
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
          pinnedGraphJson: true,
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

  // A run executes the graph snapshot frozen at its creation, so a template
  // edit mid-flight cannot rewrite what it runs. Rows created before snapshots
  // existed (graph_snapshot NULL) fall back to the template's current graph —
  // that is the graph they have been executing against all along.
  const snapshotCandidate = workflowRun.graphSnapshot ?? workflowRun.installation.workflowTemplate.graphJson
  const graphJson =
    snapshotCandidate &&
    typeof snapshotCandidate === 'object' &&
    !Array.isArray(snapshotCandidate)
      ? snapshotCandidate
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
      pinnedGraphJson: workflowRun.installation.pinnedGraphJson,
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

// W6 lease discipline: an actively-worked step (tool_call, the only kind the
// executor runs in-process today) is claimed with a lease and heartbeated while
// it works; a crash leaves an expired lease the reaper can reclaim. Suspended
// steps (agent_task, environment_launch) hold NO lease — they are waiting on an
// external continuation — and carry a deadline instead. The reaper sweeps
// either condition; a lease-only sweep would never reclaim the likeliest hangs.
export const WORKFLOW_STEP_LEASE_MS = 120_000
export const WORKFLOW_STEP_LEASE_HEARTBEAT_MS = 30_000
export const WORKFLOW_STEP_SUSPEND_DEADLINE_MS = 24 * 60 * 60 * 1000

const normalizeTimeoutMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null

export const claimWorkflowStepLease = async (
  prisma: PrismaLike,
  input: {
    leaseMs?: number
    ownerId: string
    stepRunId: string
  },
): Promise<void> => {
  const leaseMs = input.leaseMs ?? WORKFLOW_STEP_LEASE_MS
  await prisma.workflowStepRun.updateMany({
    where: { id: input.stepRunId, status: 'running' },
    data: {
      leaseOwnerId: input.ownerId,
      leaseExpiresAt: new Date(Date.now() + leaseMs),
    },
  })
}

// Renews the lease while the step is actively worked; guarded on the owner so a
// reclaimed step's heartbeat cannot steal the lease back from the reaper.
export const heartbeatWorkflowStepLease = async (
  prisma: PrismaLike,
  input: {
    leaseMs?: number
    ownerId: string
    stepRunId: string
  },
): Promise<void> => {
  const leaseMs = input.leaseMs ?? WORKFLOW_STEP_LEASE_MS
  await prisma.workflowStepRun.updateMany({
    where: {
      id: input.stepRunId,
      leaseOwnerId: input.ownerId,
      status: 'running',
    },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  })
}

export const markWorkflowStepRunStarted = async (
  prisma: PrismaLike,
  input: {
    input?: Record<string, unknown>
    leaseOwnerId?: string | null
    output?: Record<string, unknown>
    stepRunId: string
  },
): Promise<void> => {
  const now = new Date()
  const timeoutMs = normalizeTimeoutMs(input.input?.['timeoutMs'])
  await prisma.workflowStepRun.update({
    where: { id: input.stepRunId },
    data: {
      status: 'running',
      startedAt: now,
      ...(input.leaseOwnerId
        ? {
            leaseOwnerId: input.leaseOwnerId,
            leaseExpiresAt: new Date(now.getTime() + WORKFLOW_STEP_LEASE_MS),
          }
        : {}),
      ...(timeoutMs !== null ? { deadlineAt: new Date(now.getTime() + timeoutMs) } : {}),
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

    const timeoutMs = normalizeTimeoutMs(input.input?.['timeoutMs'])
    await tx.workflowStepRun.update({
      where: { id: workflowStepRunId },
      data: {
        status: 'running',
        startedAt: now,
        // Suspended step: no worker is working it, so any lease is cleared and
        // the reaper watches its deadline instead (default 24h; a step-level
        // timeoutMs overrides).
        leaseOwnerId: null,
        leaseExpiresAt: null,
        deadlineAt: new Date(now.getTime() + (timeoutMs ?? WORKFLOW_STEP_SUSPEND_DEADLINE_MS)),
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

export type WorkflowStepFinishResult = {
  applied: boolean
  continueWorkflow: boolean
  workflowRunCompleted: boolean
}

const NO_OP_STEP_FINISH: WorkflowStepFinishResult = {
  applied: false,
  continueWorkflow: false,
  workflowRunCompleted: false,
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
): Promise<WorkflowStepFinishResult> => {
  if (!input.workflowRunId || !input.stepRunId) {
    return NO_OP_STEP_FINISH
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
      return NO_OP_STEP_FINISH
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

    // Guarded on a non-terminal run status: a cancelled run (or one already
    // terminalized by a sibling step failure) is not resurrected by a late
    // child completion. The step row is left untouched in that case — it was
    // already moved to its final state by whichever transition won.
    const runUpdate = await tx.workflowRun.updateMany({
      where: {
        id: workflowRunId,
        status: { in: ['pending', 'running'] },
      },
      data: {
        status: transition.nextRunStatus,
        summary: input.summary,
        ...(transition.nextRunStatus === 'completed' || transition.nextRunStatus === 'failed'
          ? { finishedAt: new Date() }
          : {}),
      },
    })
    if (runUpdate.count === 0) {
      return NO_OP_STEP_FINISH
    }

    await tx.workflowStepRun.update({
      where: { id: stepRunId },
      data: {
        status: transition.nextStepStatus,
        output: mergedOutput as Prisma.InputJsonValue,
        errorMessage: input.success ? null : input.summary,
        finishedAt: new Date(),
        leaseOwnerId: null,
        leaseExpiresAt: null,
        deadlineAt: null,
      },
    })

    // A failed step terminalizes the run: anything still pending or blocked
    // is never going to execute, so mark it skipped rather than leaving it
    // reading as "still coming".
    if (transition.nextRunStatus === 'failed') {
      await tx.workflowStepRun.updateMany({
        where: {
          workflowRunId,
          status: { in: ['pending', 'blocked'] },
        },
        data: {
          status: 'skipped',
          finishedAt: new Date(),
        },
      })
    }

    return {
      applied: true,
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
): Promise<{ applied: boolean }> => {
  // Same non-terminal guard as the step finish: a concurrent cancel wins and
  // the loser reports `applied: false` so its caller emits no terminal event.
  const result = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      status: { in: ['pending', 'running'] },
    },
    data: {
      status: input.success ? 'completed' : 'failed',
      output: (input.output ?? {}) as Prisma.InputJsonValue,
      summary: input.summary,
      errorMessage: input.success ? null : input.summary,
      finishedAt: new Date(),
    },
  })
  return { applied: result.count > 0 }
}
