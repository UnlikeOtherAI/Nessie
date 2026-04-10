import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  type WorkflowRunExecuteJobPayload,
} from '@nessie/schemas'
import type {
  WorkflowGraph,
  WorkflowInstallationRecord,
  WorkflowRunRecord,
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../contracts.js'
import { WorkflowGraphSchema } from '../contracts.js'
import { enqueueQueueJob } from '../queue/pgqueue.js'
import { parseOptional, toJsonRecord } from './contract-helpers.js'

type WorkflowTemplateWithGraph = {
  bindingSchema: unknown
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  description: string | null
  graphJson: unknown
  id: string
  name: string
  organizationId: string
  requiredEnvironmentTemplateIds: unknown
  triggersJson: unknown
  updatedAt: Date
  variableSchema: unknown
  version: number
}

type WorkflowInstallationRow = {
  active: boolean
  channelId: string | null
  config: unknown
  createdAt: Date
  createdByActorId: string
  createdByActorType: string
  id: string
  organizationId: string
  projectId: string | null
  resolvedBindings: unknown
  status: 'active' | 'disabled' | 'draft' | 'paused'
  teamId: string | null
  updatedAt: Date
  workflowTemplateId: string
  workflowTemplateVersion: number
}

type WorkflowRunRow = {
  createdAt: Date
  errorMessage: string | null
  finishedAt: Date | null
  id: string
  input: unknown
  installationId: string
  organizationId: string
  output: unknown
  parentRunId: string | null
  planId: string | null
  planStepId: string | null
  startedAt: Date | null
  startedByActorId: string
  startedByActorType: string
  status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  summary: string | null
  triggerDeliveryId: string | null
  triggerId: string | null
  updatedAt: Date
}

type WorkflowStepRunRow = {
  agentRunId: string | null
  assignedAgentId: string | null
  createdAt: Date
  environmentInstance: { id: string } | null
  errorMessage: string | null
  finishedAt: Date | null
  id: string
  input: unknown
  output: unknown
  sequence: number
  startedAt: Date | null
  status: 'blocked' | 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
  stepKey: string
  stepType: string
  taskId: string | null
  title: string
  updatedAt: Date
  workflowRunId: string
}

const parseWorkflowGraph = (value: unknown): WorkflowGraph =>
  WorkflowGraphSchema.parse(value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

const validateRequiredEnvironmentTemplateIds = async (
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

const validateWorkflowInstallationChannel = async (
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
    },
    select: { id: true },
  })

  if (!channel) {
    throw new Error('WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')
  }
}

const validateWorkflowRunReferences = async (
  prisma: Prisma.TransactionClient,
  organizationId: string,
  input: {
    parentRunId?: string
    planId?: string
    planStepId?: string
    triggerDeliveryId?: string
    triggerId?: string
  },
): Promise<void> => {
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

const mapWorkflowTemplate = (
  template: WorkflowTemplateWithGraph,
): WorkflowTemplateRecord => ({
  id: template.id,
  organizationId: parseOrganizationId(template.organizationId),
  name: template.name,
  description: template.description ?? undefined,
  version: template.version,
  graph: parseWorkflowGraph(template.graphJson),
  triggers: template.triggersJson,
  variableSchema: template.variableSchema,
  bindingSchema: template.bindingSchema,
  requiredEnvironmentTemplateIds: parseUuidArray(template.requiredEnvironmentTemplateIds),
  createdByActorType: template.createdByActorType,
  createdByActorId: template.createdByActorId,
  createdAt: template.createdAt.toISOString(),
  updatedAt: template.updatedAt.toISOString(),
})

const mapWorkflowInstallation = (
  installation: WorkflowInstallationRow,
): WorkflowInstallationRecord => ({
  id: installation.id,
  workflowTemplateId: installation.workflowTemplateId,
  workflowTemplateVersion: installation.workflowTemplateVersion,
  organizationId: parseOrganizationId(installation.organizationId),
  projectId: installation.projectId ?? undefined,
  teamId: installation.teamId ?? undefined,
  channelId: parseOptional(installation.channelId, parseChannelId),
  status: installation.status,
  active: installation.active,
  resolvedBindings: toJsonRecord(installation.resolvedBindings),
  config: toJsonRecord(installation.config),
  createdByActorType: installation.createdByActorType,
  createdByActorId: installation.createdByActorId,
  createdAt: installation.createdAt.toISOString(),
  updatedAt: installation.updatedAt.toISOString(),
})

const mapWorkflowRun = (run: WorkflowRunRow): WorkflowRunRecord => ({
  id: run.id,
  installationId: run.installationId,
  organizationId: parseOrganizationId(run.organizationId),
  triggerId: run.triggerId ?? undefined,
  triggerDeliveryId: run.triggerDeliveryId ?? undefined,
  parentRunId: parseOptional(run.parentRunId, parseRunId),
  planId: run.planId ?? undefined,
  planStepId: run.planStepId ?? undefined,
  status: run.status,
  input: run.input ?? {},
  output: run.output ?? {},
  summary: run.summary ?? undefined,
  errorMessage: run.errorMessage ?? undefined,
  startedByActorType: run.startedByActorType,
  startedByActorId: run.startedByActorId,
  startedAt: run.startedAt?.toISOString(),
  finishedAt: run.finishedAt?.toISOString(),
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
})

const mapWorkflowStepRun = (
  stepRun: WorkflowStepRunRow,
): WorkflowStepRunRecord => ({
  id: stepRun.id,
  workflowRunId: stepRun.workflowRunId,
  stepKey: stepRun.stepKey,
  stepType: stepRun.stepType,
  title: stepRun.title,
  sequence: stepRun.sequence,
  status: stepRun.status,
  input: stepRun.input ?? {},
  output: stepRun.output ?? {},
  errorMessage: stepRun.errorMessage ?? undefined,
  assignedAgentId: parseOptional(stepRun.assignedAgentId, parseAgentId),
  agentRunId: parseOptional(stepRun.agentRunId, parseRunId),
  taskId: stepRun.taskId ?? undefined,
  environmentInstanceId: stepRun.environmentInstance?.id ?? undefined,
  startedAt: stepRun.startedAt?.toISOString(),
  finishedAt: stepRun.finishedAt?.toISOString(),
  createdAt: stepRun.createdAt.toISOString(),
  updatedAt: stepRun.updatedAt.toISOString(),
})

export const listWorkflowTemplates = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<WorkflowTemplateRecord[]> => {
  const templates = await prisma.workflowTemplate.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })

  return templates.map(mapWorkflowTemplate)
}

export const createWorkflowTemplate = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    bindingSchema?: unknown
    description?: string
    graph: WorkflowGraph
    name: string
    requiredEnvironmentTemplateIds?: string[]
    triggers?: unknown
    variableSchema?: unknown
  },
): Promise<WorkflowTemplateRecord> => {
  await validateRequiredEnvironmentTemplateIds(
    prisma,
    actorContext.tenant.organizationId,
    input.requiredEnvironmentTemplateIds ?? [],
  )

  const template = await prisma.workflowTemplate.create({
    data: {
      organizationId: actorContext.tenant.organizationId,
      name: input.name,
      description: input.description,
      graphJson: input.graph as unknown as Prisma.InputJsonValue,
      triggersJson: (input.triggers ?? {}) as Prisma.InputJsonValue,
      variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
      bindingSchema: (input.bindingSchema ?? {}) as Prisma.InputJsonValue,
      requiredEnvironmentTemplateIds:
        (input.requiredEnvironmentTemplateIds ?? []) as unknown as Prisma.InputJsonValue,
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapWorkflowTemplate(template)
}

export const getWorkflowTemplate = async (
  prisma: PrismaClient,
  organizationId: string,
  workflowTemplateId: string,
): Promise<WorkflowTemplateRecord | null> => {
  const template = await prisma.workflowTemplate.findFirst({
    where: {
      id: workflowTemplateId,
      organizationId,
    },
  })

  return template ? mapWorkflowTemplate(template) : null
}

export const installWorkflowTemplate = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowTemplateId: string,
  input: {
    active?: boolean
    channelId?: string
    config?: Record<string, unknown>
    resolvedBindings?: Record<string, unknown>
    status?: WorkflowInstallationRecord['status']
  },
): Promise<WorkflowInstallationRecord | null> => {
  await validateWorkflowInstallationChannel(
    prisma,
    actorContext.tenant.organizationId,
    input.channelId,
  )

  const template = await prisma.workflowTemplate.findFirst({
    where: {
      id: workflowTemplateId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: {
      id: true,
      version: true,
    },
  })
  if (!template) {
    return null
  }

  const installation = await prisma.workflowInstallation.create({
    data: {
      workflowTemplateId: template.id,
      workflowTemplateVersion: template.version,
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId,
      teamId: actorContext.tenant.teamId,
      channelId: input.channelId,
      status: input.status ?? (input.active === false ? 'paused' : 'active'),
      active: input.active ?? true,
      resolvedBindings: (input.resolvedBindings ?? {}) as Prisma.InputJsonValue,
      config: (input.config ?? {}) as Prisma.InputJsonValue,
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })

  return mapWorkflowInstallation(installation)
}

export const listWorkflowInstallations = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<WorkflowInstallationRecord[]> => {
  const installations = await prisma.workflowInstallation.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
  })

  return installations.map(mapWorkflowInstallation)
}

export const createWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
  input: {
    input?: Record<string, unknown>
    parentRunId?: string
    planId?: string
    planStepId?: string
    triggerDeliveryId?: string
    triggerId?: string
  },
): Promise<WorkflowRunRecord | null> => {
  const result = await prisma.$transaction(async (tx) => {
    const installation = await tx.workflowInstallation.findFirst({
      where: {
        id: installationId,
        organizationId: actorContext.tenant.organizationId,
        active: true,
        status: {
          in: ['active', 'draft'],
        },
      },
      select: {
        id: true,
        organizationId: true,
      },
    })
    if (!installation) {
      return null
    }

    await validateWorkflowRunReferences(tx, installation.organizationId, input)

    const run = await tx.workflowRun.create({
      data: {
        installationId: installation.id,
        organizationId: installation.organizationId,
        triggerId: input.triggerId,
        triggerDeliveryId: input.triggerDeliveryId,
        parentRunId: input.parentRunId,
        planId: input.planId,
        planStepId: input.planStepId,
        input: (input.input ?? {}) as Prisma.InputJsonValue,
        startedByActorType: actorContext.actor.actorType,
        startedByActorId: actorContext.actor.actorId,
      },
    })

    const payload: WorkflowRunExecuteJobPayload = {
      actorContext,
      workflowRunId: run.id,
    }
    await enqueueQueueJob(tx, {
      idempotencyKey: `workflow-run:start:${run.id}`,
      payload,
      topic: 'workflow.run.execute',
    })

    return run
  })

  return result ? mapWorkflowRun(result) : null
}

export const listWorkflowRuns = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    installationId?: string
  },
): Promise<WorkflowRunRecord[]> => {
  const runs = await prisma.workflowRun.findMany({
    where: {
      organizationId,
      ...(input.installationId ? { installationId: input.installationId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })

  return runs.map(mapWorkflowRun)
}

export const getWorkflowRun = async (
  prisma: PrismaClient,
  organizationId: string,
  workflowRunId: string,
): Promise<{ run: WorkflowRunRecord; steps: WorkflowStepRunRecord[] } | null> => {
  const run = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId,
    },
  })
  if (!run) {
    return null
  }

  const steps = await prisma.workflowStepRun.findMany({
    where: {
      workflowRunId,
    },
    include: {
      environmentInstance: {
        select: { id: true },
      },
    },
    orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }],
  })

  return {
    run: mapWorkflowRun(run),
    steps: steps.map(mapWorkflowStepRun),
  }
}
