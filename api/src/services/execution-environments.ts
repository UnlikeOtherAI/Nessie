import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  AuthorizedActionContext,
  ExecutionEnvironmentAllocateJobPayload,
} from '@nessie/schemas'
import { parseAgentId, parseChannelId, parseOrganizationId, parseRunId } from '@nessie/schemas'
import type {
  ExecutionEnvironmentInstanceRecord,
  ExecutionEnvironmentTemplateRecord,
  ExecutionLeaseRecord,
  ExecutionRunnerRecord,
  ExecutionUsageLedgerRecord,
} from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { parseOptional } from './contract-helpers.js'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const parseNonNegativeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const mapExecutionEnvironmentTemplate = (template: {
  channelId: string | null
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  description: string | null
  enabled: boolean
  id: string
  image: string | null
  launchConfig: unknown
  mode: 'container' | 'function' | 'vm'
  name: string
  organizationId: string
  pricingConfig: unknown
  projectId: string | null
  provider: 'docker' | 'gcloud'
  teamId: string | null
  updatedAt: Date
}): ExecutionEnvironmentTemplateRecord => ({
  id: template.id,
  organizationId: parseOrganizationId(template.organizationId),
  projectId: template.projectId ?? undefined,
  teamId: template.teamId ?? undefined,
  channelId: parseOptional(template.channelId, parseChannelId),
  name: template.name,
  description: template.description ?? undefined,
  provider: template.provider,
  mode: template.mode,
  image: template.image ?? undefined,
  launchConfig: asObject(template.launchConfig),
  pricingConfig: asObject(template.pricingConfig),
  enabled: template.enabled,
  createdByActorType: template.createdByActorType,
  createdByActorId: template.createdByActorId,
  createdAt: template.createdAt.toISOString(),
  updatedAt: template.updatedAt.toISOString(),
})

const mapExecutionEnvironmentInstance = (instance: {
  agentId: string | null
  channelId: string | null
  createdAt: Date
  errorMessage: string | null
  id: string
  lastHeartbeatAt: Date | null
  launchConfig: unknown
  launchedByActorId: string
  launchedByActorType: string
  metadata: unknown
  organizationId: string
  projectId: string | null
  providerInstanceRef: string | null
  readyAt: Date | null
  runId: string | null
  startedAt: Date | null
  status: 'failed' | 'pending' | 'provisioning' | 'ready' | 'terminated'
  teamId: string | null
  templateId: string
  terminatedAt: Date | null
  updatedAt: Date
  workflowRunId: string | null
  workflowStepRunId: string | null
}): ExecutionEnvironmentInstanceRecord => ({
  id: instance.id,
  templateId: instance.templateId,
  organizationId: parseOrganizationId(instance.organizationId),
  projectId: instance.projectId ?? undefined,
  teamId: instance.teamId ?? undefined,
  channelId: parseOptional(instance.channelId, parseChannelId),
  workflowRunId: instance.workflowRunId ?? undefined,
  workflowStepRunId: instance.workflowStepRunId ?? undefined,
  runId: parseOptional(instance.runId, parseRunId),
  agentId: parseOptional(instance.agentId, parseAgentId),
  status: instance.status,
  launchedByActorType: instance.launchedByActorType,
  launchedByActorId: instance.launchedByActorId,
  providerInstanceRef: instance.providerInstanceRef ?? undefined,
  launchConfig: asObject(instance.launchConfig),
  metadata: asObject(instance.metadata),
  errorMessage: instance.errorMessage ?? undefined,
  startedAt: instance.startedAt?.toISOString(),
  readyAt: instance.readyAt?.toISOString(),
  terminatedAt: instance.terminatedAt?.toISOString(),
  lastHeartbeatAt: instance.lastHeartbeatAt?.toISOString(),
  createdAt: instance.createdAt.toISOString(),
  updatedAt: instance.updatedAt.toISOString(),
})

const mapExecutionRunner = (runner: {
  capabilities: unknown
  createdAt: Date
  heartbeatAt: Date | null
  id: string
  label: string
  metadata: unknown
  organizationId: string | null
  provider: 'docker' | 'gcloud'
  status: 'active' | 'draining' | 'offline'
  updatedAt: Date
}): ExecutionRunnerRecord => ({
  id: runner.id,
  organizationId: runner.organizationId
    ? parseOrganizationId(runner.organizationId)
    : undefined,
  provider: runner.provider,
  label: runner.label,
  capabilities: asObject(runner.capabilities),
  status: runner.status,
  heartbeatAt: runner.heartbeatAt?.toISOString(),
  metadata: asObject(runner.metadata),
  createdAt: runner.createdAt.toISOString(),
  updatedAt: runner.updatedAt.toISOString(),
})

const mapExecutionLease = (lease: {
  acknowledgedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  expiresAt: Date
  id: string
  instanceId: string
  leaseToken: string
  runnerId: string
  status: 'acknowledged' | 'completed' | 'expired' | 'issued' | 'revoked'
  updatedAt: Date
}): ExecutionLeaseRecord => ({
  id: lease.id,
  instanceId: lease.instanceId,
  runnerId: lease.runnerId,
  status: lease.status,
  leaseToken: lease.leaseToken,
  expiresAt: lease.expiresAt.toISOString(),
  acknowledgedAt: lease.acknowledgedAt?.toISOString(),
  completedAt: lease.completedAt?.toISOString(),
  createdAt: lease.createdAt.toISOString(),
  updatedAt: lease.updatedAt.toISOString(),
})

const mapExecutionUsageLedger = (entry: {
  actorId: string
  actorType: string
  agentId: string | null
  channelId: string | null
  costAmount: number | null
  currency: string | null
  id: string
  instanceId: string
  metadata: unknown
  meterType: string
  organizationId: string
  projectId: string | null
  quantity: number
  recordedAt: Date
  runId: string | null
  teamId: string | null
  templateId: string
  unitPrice: number | null
  workflowRunId: string | null
  workflowStepRunId: string | null
}): ExecutionUsageLedgerRecord => ({
  id: entry.id,
  instanceId: entry.instanceId,
  templateId: entry.templateId,
  organizationId: parseOrganizationId(entry.organizationId),
  projectId: entry.projectId ?? undefined,
  teamId: entry.teamId ?? undefined,
  channelId: parseOptional(entry.channelId, parseChannelId),
  workflowRunId: entry.workflowRunId ?? undefined,
  workflowStepRunId: entry.workflowStepRunId ?? undefined,
  runId: parseOptional(entry.runId, parseRunId),
  agentId: parseOptional(entry.agentId, parseAgentId),
  actorType: entry.actorType,
  actorId: entry.actorId,
  meterType: entry.meterType,
  quantity: entry.quantity,
  unitPrice: entry.unitPrice ?? undefined,
  costAmount: entry.costAmount ?? undefined,
  currency: entry.currency ?? undefined,
  metadata: asObject(entry.metadata),
  recordedAt: entry.recordedAt.toISOString(),
})

const computeUsageCost = (input: {
  pricingConfig: unknown
  quantity: number
}): { costAmount?: number; currency?: string; unitPrice?: number } => {
  const pricing = asObject(input.pricingConfig)
  const unitPrice = parseNonNegativeNumber(pricing['unitPrice'])
  const currency = typeof pricing['currency'] === 'string' ? pricing['currency'] : undefined

  if (unitPrice === null) {
    return { currency }
  }

  return {
    unitPrice,
    costAmount: Number((unitPrice * input.quantity).toFixed(6)),
    currency,
  }
}

const validateChannelOwnership = async (
  prisma: Prisma.TransactionClient | PrismaClient,
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
    },
    select: { id: true },
  })

  if (!channel) {
    throw new Error('EXECUTION_ENVIRONMENT_CHANNEL_NOT_FOUND')
  }
}

const validateExecutionEnvironmentReferences = async (
  prisma: Prisma.TransactionClient,
  organizationId: string,
  input: {
    agentId?: string
    runId?: string
    workflowRunId?: string
    workflowStepRunId?: string
  },
): Promise<void> => {
  if (input.agentId) {
    const agent = await prisma.agent.findFirst({
      where: {
        id: input.agentId,
        organizationId,
      },
      select: { id: true },
    })
    if (!agent) {
      throw new Error('EXECUTION_ENVIRONMENT_AGENT_NOT_FOUND')
    }
  }

  if (input.runId) {
    const run = await prisma.run.findFirst({
      where: {
        id: input.runId,
        thread: {
          channel: {
            organizationId,
          },
        },
      },
      select: { id: true },
    })
    if (!run) {
      throw new Error('EXECUTION_ENVIRONMENT_RUN_NOT_FOUND')
    }
  }

  if (input.workflowRunId) {
    const workflowRun = await prisma.workflowRun.findFirst({
      where: {
        id: input.workflowRunId,
        organizationId,
      },
      select: { id: true },
    })
    if (!workflowRun) {
      throw new Error('EXECUTION_ENVIRONMENT_WORKFLOW_RUN_NOT_FOUND')
    }
  }

  if (input.workflowStepRunId) {
    const workflowStepRun = await prisma.workflowStepRun.findFirst({
      where: {
        id: input.workflowStepRunId,
        workflowRun: {
          organizationId,
        },
      },
      select: {
        workflowRunId: true,
      },
    })
    if (!workflowStepRun) {
      throw new Error('EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_NOT_FOUND')
    }
    if (input.workflowRunId && workflowStepRun.workflowRunId !== input.workflowRunId) {
      throw new Error('EXECUTION_ENVIRONMENT_WORKFLOW_STEP_RUN_MISMATCH')
    }
  }
}

export const listExecutionEnvironmentTemplates = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<ExecutionEnvironmentTemplateRecord[]> => {
  const templates = await prisma.executionEnvironmentTemplate.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })

  return templates.map(mapExecutionEnvironmentTemplate)
}

export const createExecutionEnvironmentTemplate = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    channelId?: string
    description?: string
    enabled?: boolean
    image?: string
    launchConfig?: Record<string, unknown>
    mode: 'container' | 'function' | 'vm'
    name: string
    pricingConfig?: Record<string, unknown>
    provider: 'docker' | 'gcloud'
  },
): Promise<ExecutionEnvironmentTemplateRecord> => {
  await validateChannelOwnership(
    prisma,
    actorContext.tenant.organizationId,
    input.channelId,
  )

  const template = await prisma.executionEnvironmentTemplate.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
      channelId: input.channelId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      mode: input.mode,
      image: input.image,
      launchConfig: (input.launchConfig ?? {}) as Prisma.InputJsonValue,
      pricingConfig: (input.pricingConfig ?? {}) as Prisma.InputJsonValue,
      enabled: input.enabled ?? true,
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapExecutionEnvironmentTemplate(template)
}

export const listExecutionEnvironmentInstances = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    workflowRunId?: string
  },
): Promise<ExecutionEnvironmentInstanceRecord[]> => {
  const instances = await prisma.executionEnvironmentInstance.findMany({
    where: {
      organizationId,
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return instances.map(mapExecutionEnvironmentInstance)
}

export const requestExecutionEnvironmentLaunch = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    agentId?: string
    channelId?: string
    launchConfig?: Record<string, unknown>
    runId?: string
    templateId: string
    workflowRunId?: string
    workflowStepRunId?: string
  },
): Promise<ExecutionEnvironmentInstanceRecord | null> => {
  const instance = await prisma.$transaction(async (tx) => {
    const template = await tx.executionEnvironmentTemplate.findFirst({
      where: {
        id: input.templateId,
        organizationId: actorContext.tenant.organizationId,
        enabled: true,
      },
      select: {
        channelId: true,
        id: true,
      },
    })
    if (!template) {
      return null
    }

    await validateChannelOwnership(
      tx,
      actorContext.tenant.organizationId,
      input.channelId ?? template.channelId ?? undefined,
    )
    await validateExecutionEnvironmentReferences(tx, actorContext.tenant.organizationId, input)

    const instanceRow = await tx.executionEnvironmentInstance.create({
      data: {
        templateId: template.id,
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId: actorContext.tenant.teamId,
        channelId: input.channelId ?? template.channelId,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        runId: input.runId,
        agentId: input.agentId,
        launchedByActorType: actorContext.actor.actorType,
        launchedByActorId: actorContext.actor.actorId,
        launchConfig: (input.launchConfig ?? {}) as Prisma.InputJsonValue,
      },
    })

    const payload: ExecutionEnvironmentAllocateJobPayload = {
      actorContext,
      instanceId: instanceRow.id,
    }
    await enqueueQueueJob(tx, {
      idempotencyKey: `execution-environment:${instanceRow.id}`,
      payload,
      topic: 'execution.environment.allocate',
    })

    return instanceRow
  })

  return instance ? mapExecutionEnvironmentInstance(instance) : null
}

export const terminateExecutionEnvironmentInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  instanceId: string,
): Promise<ExecutionEnvironmentInstanceRecord | null> => {
  const now = new Date()

  const instance = await prisma.$transaction(async (tx) => {
    const existing = await tx.executionEnvironmentInstance.findFirst({
      where: {
        id: instanceId,
        organizationId,
      },
      include: {
        template: {
          select: {
            id: true,
            pricingConfig: true,
          },
        },
      },
    })
    if (!existing) {
      return null
    }

    const updated = await tx.executionEnvironmentInstance.update({
      where: { id: existing.id },
      data: {
        status: 'terminated',
        terminatedAt: now,
      },
    })

    const billableMinutes =
      existing.startedAt && now.getTime() > existing.startedAt.getTime()
        ? Math.max(1, Math.ceil((now.getTime() - existing.startedAt.getTime()) / 60_000))
        : 0

    if (billableMinutes > 0) {
      const pricing = computeUsageCost({
        pricingConfig: existing.template.pricingConfig,
        quantity: billableMinutes,
      })

      await tx.executionUsageLedger.create({
        data: {
          instanceId: existing.id,
          templateId: existing.template.id,
          organizationId: existing.organizationId,
          projectId: existing.projectId,
          teamId: existing.teamId,
          channelId: existing.channelId,
          workflowRunId: existing.workflowRunId,
          workflowStepRunId: existing.workflowStepRunId,
          runId: existing.runId,
          agentId: existing.agentId,
          actorType: existing.launchedByActorType,
          actorId: existing.launchedByActorId,
          meterType: 'uptime_min',
          quantity: billableMinutes,
          unitPrice: pricing.unitPrice,
          costAmount: pricing.costAmount,
          currency: pricing.currency,
          metadata: {
            terminatedAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
    }

    await tx.executionLease.updateMany({
      where: {
        instanceId: existing.id,
        status: {
          in: ['issued', 'acknowledged'],
        },
      },
      data: {
        status: 'completed',
        completedAt: now,
      },
    })

    return updated
  })

  return instance ? mapExecutionEnvironmentInstance(instance) : null
}

export const listExecutionUsageLedger = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    instanceId?: string
    workflowRunId?: string
  },
): Promise<ExecutionUsageLedgerRecord[]> => {
  const entries = await prisma.executionUsageLedger.findMany({
    where: {
      organizationId,
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    },
    orderBy: [{ recordedAt: 'desc' }],
  })

  return entries.map(mapExecutionUsageLedger)
}

export const listExecutionRunners = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<ExecutionRunnerRecord[]> => {
  const runners = await prisma.executionRunner.findMany({
    where: {
      OR: [{ organizationId }, { organizationId: null }],
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return runners.map(mapExecutionRunner)
}

export const listExecutionLeases = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    instanceId?: string
  },
): Promise<ExecutionLeaseRecord[]> => {
  const leases = await prisma.executionLease.findMany({
    where: {
      instance: {
        organizationId,
      },
      ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return leases.map(mapExecutionLease)
}
