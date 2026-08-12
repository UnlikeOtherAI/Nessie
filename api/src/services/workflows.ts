import { Prisma, type PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import { resolveInstallationPinnedGraph } from '@nessie/workspace-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  type AgentTriggerType,
  type ExecutionEnvironmentTerminateJobPayload,
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
import { createWorkflowTrigger } from './triggers.js'

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
  retriedFromWorkflowRunId: string | null
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

type WorkflowTemplateTriggerDefinition = {
  config: Record<string, unknown>
  description?: string
  enabled?: boolean
  name?: string
  nextRunAt?: string
  type: AgentTriggerType
}

const WORKFLOW_TEMPLATE_TRIGGER_TYPES: AgentTriggerType[] = [
  'manual',
  'scheduled',
  'interval',
  'webhook',
  'event',
]

const parseWorkflowGraph = (value: unknown): WorkflowGraph =>
  WorkflowGraphSchema.parse(value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

const isWorkflowTemplateTriggerType = (
  value: unknown,
): value is AgentTriggerType =>
  typeof value === 'string' &&
  (WORKFLOW_TEMPLATE_TRIGGER_TYPES as string[]).includes(value)

const parseWorkflowTemplateTriggers = (
  value: unknown,
): WorkflowTemplateTriggerDefinition[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return []
        }

        const record = entry as Record<string, unknown>
        const config =
          record.config && typeof record.config === 'object' && !Array.isArray(record.config)
            ? (record.config as Record<string, unknown>)
            : {}
        const type = isWorkflowTemplateTriggerType(record.type)
          ? record.type
          : isWorkflowTemplateTriggerType(record.sourceId)
            ? record.sourceId
            : isWorkflowTemplateTriggerType(config.type)
              ? config.type
              : undefined

        if (!type) {
          return []
        }

        return [
          {
            config,
            description:
              typeof record.description === 'string' ? record.description : undefined,
            enabled:
              typeof record.enabled === 'boolean' ? record.enabled : undefined,
            name:
              typeof record.name === 'string'
                ? record.name
                : typeof record.title === 'string'
                  ? record.title
                  : undefined,
            nextRunAt:
              typeof record.nextRunAt === 'string' ? record.nextRunAt : undefined,
            type,
          } satisfies WorkflowTemplateTriggerDefinition,
        ]
      })
    : []

/**
 * Save-time validation of workflow graph steps against what the worker
 * runtime actually executes (`worker/src/control/workflows.ts`). Anything
 * rejected here would otherwise fail the run at execution time. Values that
 * contain `{{ … }}` binding tokens are resolved at run time, so literal
 * checks are skipped for them; `channelId` is never required because the
 * runtime falls back to the installation's channel.
 */
export class WorkflowTemplateValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super('WORKFLOW_TEMPLATE_INVALID')
    this.issues = issues
  }
}

const WORKFLOW_STEP_TYPES = new Set([
  'agent',
  'agent_task',
  'environment_launch',
  'tool',
  'tool_call',
  'trigger',
])

const hasBindingToken = (value: unknown): boolean =>
  typeof value === 'string' && value.includes('{{')

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const readStepInputString = (
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = input?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export const validateWorkflowGraphSteps = async (
  prisma: PrismaClient,
  organizationId: string,
  graph: WorkflowGraph,
): Promise<void> => {
  const issues: string[] = []
  const seenStepIds = new Set<string>()
  const literalAgentIds = new Set<string>()

  for (const step of graph.steps) {
    const label = step.title?.trim() || step.id

    if (seenStepIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" — step outputs would collide.`)
    }
    seenStepIds.add(step.id)

    if (!WORKFLOW_STEP_TYPES.has(step.type)) {
      issues.push(
        `Step "${label}" has unsupported type "${step.type}". Supported: trigger, tool, agent, environment_launch.`,
      )
      continue
    }

    if (step.type === 'tool' || step.type === 'tool_call') {
      const toolName = readStepInputString(step.input, 'toolName')
      if (!toolName) {
        issues.push(`Tool step "${label}" is missing toolName.`)
      } else if (!hasBindingToken(toolName) && !WORKFLOW_TOOL_IDS.has(toolName)) {
        issues.push(
          `Tool step "${label}" uses unknown tool "${toolName}". Available: ${[...WORKFLOW_TOOL_IDS].sort().join(', ')}.`,
        )
      }
    }

    if (step.type === 'agent' || step.type === 'agent_task') {
      const agentId = readStepInputString(step.input, 'agentId')
      if (!agentId) {
        issues.push(`Agent step "${label}" is missing agentId.`)
      } else if (!hasBindingToken(agentId)) {
        if (UUID_PATTERN.test(agentId)) {
          literalAgentIds.add(agentId)
        } else {
          issues.push(`Agent step "${label}" has an invalid agentId "${agentId}".`)
        }
      }
    }

    if (step.type === 'environment_launch') {
      const templateId = readStepInputString(step.input, 'templateId')
      const templateBindingKey = readStepInputString(step.input, 'templateBindingKey')
      if (!templateId && !templateBindingKey) {
        issues.push(
          `Environment step "${label}" needs templateId or templateBindingKey.`,
        )
      }
    }
  }

  if (literalAgentIds.size > 0) {
    const agents = await prisma.agent.findMany({
      where: {
        id: { in: [...literalAgentIds] },
        OR: [{ organizationId }, { organizationId: null }],
      },
      select: { id: true },
    })
    const foundIds = new Set(agents.map((agent) => agent.id))
    for (const agentId of literalAgentIds) {
      if (!foundIds.has(agentId)) {
        issues.push(`Agent ${agentId.slice(0, 8)} referenced by an agent step does not exist.`)
      }
    }
  }

  if (issues.length > 0) {
    throw new WorkflowTemplateValidationError(issues)
  }
}

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
      systemChannelType: null,
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
  retriedFromWorkflowRunId: run.retriedFromWorkflowRunId ?? undefined,
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

const WORKFLOW_LIST_LIMIT = 200

export const listWorkflowTemplates = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<WorkflowTemplateRecord[]> => {
  // List view omits the large `graphJson` blob; the full graph is only fetched
  // by the single-item GET. The contract still requires `graph`, so the list
  // mapper substitutes an empty graph.
  const templates = await prisma.workflowTemplate.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
    take: WORKFLOW_LIST_LIMIT,
    select: {
      id: true,
      organizationId: true,
      name: true,
      description: true,
      version: true,
      graphJson: true,
      triggersJson: true,
      variableSchema: true,
      bindingSchema: true,
      requiredEnvironmentTemplateIds: true,
      createdByActorType: true,
      createdByActorId: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  // The real graph must be returned: WorkflowGraphSchema requires at least
  // one step, so substituting an empty graph made this endpoint 500 as soon
  // as any template existed — and the admin list renders step counts.
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
  await validateWorkflowGraphSteps(
    prisma,
    actorContext.tenant.organizationId,
    input.graph,
  )
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

export const updateWorkflowTemplate = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowTemplateId: string,
  input: {
    bindingSchema?: unknown
    description?: string
    graph: WorkflowGraph
    name: string
    requiredEnvironmentTemplateIds?: string[]
    triggers?: unknown
    variableSchema?: unknown
  },
): Promise<WorkflowTemplateRecord | null> => {
  await validateWorkflowGraphSteps(
    prisma,
    actorContext.tenant.organizationId,
    input.graph,
  )
  await validateRequiredEnvironmentTemplateIds(
    prisma,
    actorContext.tenant.organizationId,
    input.requiredEnvironmentTemplateIds ?? [],
  )

  const existingTemplate = await prisma.workflowTemplate.findFirst({
    where: {
      id: workflowTemplateId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: {
      id: true,
      version: true,
    },
  })

  if (!existingTemplate) {
    return null
  }

  const template = await prisma.workflowTemplate.update({
    where: {
      id: existingTemplate.id,
    },
    data: {
      name: input.name,
      description: input.description,
      version: {
        increment: 1,
      },
      graphJson: input.graph as unknown as Prisma.InputJsonValue,
      triggersJson: (input.triggers ?? {}) as Prisma.InputJsonValue,
      variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
      bindingSchema: (input.bindingSchema ?? {}) as Prisma.InputJsonValue,
      requiredEnvironmentTemplateIds:
        (input.requiredEnvironmentTemplateIds ?? []) as unknown as Prisma.InputJsonValue,
    },
  })

  return mapWorkflowTemplate(template)
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

  const result = await prisma.$transaction(async (tx) => {
    const template = await tx.workflowTemplate.findFirst({
      where: {
        id: workflowTemplateId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: {
        id: true,
        graphJson: true,
        triggersJson: true,
        version: true,
      },
    })
    if (!template) {
      return null
    }

    const installation = await tx.workflowInstallation.create({
      data: {
        workflowTemplateId: template.id,
        workflowTemplateVersion: template.version,
        // W4: pin the installed graph so a NEW run is reproducible from what
        // was installed, not from whatever the template says later.
        pinnedGraphJson: template.graphJson as Prisma.InputJsonValue,
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

    for (const triggerDefinition of parseWorkflowTemplateTriggers(template.triggersJson)) {
      const createdTrigger = await createWorkflowTrigger(tx, installation.id, triggerDefinition)
      if (!createdTrigger) {
        throw new Error('WORKFLOW_TEMPLATE_TRIGGER_INVALID')
      }
    }

    return installation
  })

  return result ? mapWorkflowInstallation(result) : null
}

export const listWorkflowInstallations = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<WorkflowInstallationRecord[]> => {
  const installations = await prisma.workflowInstallation.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }],
    take: WORKFLOW_LIST_LIMIT,
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
        // W4: freeze the graph this run executes from.
        graphSnapshot: await resolveInstallationPinnedGraph(tx, installation.id),
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
  // List view omits the large `input`/`output` Json blobs; they are only
  // fetched by the single-run GET. The contract still requires them, so the
  // list mapper substitutes empty objects.
  const runs = await prisma.workflowRun.findMany({
    where: {
      organizationId,
      ...(input.installationId ? { installationId: input.installationId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    take: WORKFLOW_LIST_LIMIT,
    select: {
      id: true,
      installationId: true,
      organizationId: true,
      triggerId: true,
      triggerDeliveryId: true,
      parentRunId: true,
      retriedFromWorkflowRunId: true,
      planId: true,
      planStepId: true,
      status: true,
      summary: true,
      errorMessage: true,
      startedByActorType: true,
      startedByActorId: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return runs.map((run) => mapWorkflowRun({ ...run, input: {}, output: {} }))
}

const TOOL_STEP_CANCEL_NOTICE =
  'may still execute: the tool call was already dispatched and its side effect cannot be recalled.'

// Cancelling a workflow run must propagate to the work it suspended, not just
// flip rows: a running agent step keeps a suspended child run alive, a running
// environment_launch step holds a live instance, and a running tool step may
// still land a side effect. Each running step records what was abandoned on
// its output so the surface is honest about what cancel did and did not stop.
export const cancelWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  input: { reason?: string } = {},
): Promise<WorkflowRunRecord | null> => {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.workflowRun.findFirst({
      where: {
        id: workflowRunId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: { id: true, status: true },
    })
    if (!existing) {
      return null
    }
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return tx.workflowRun.findUnique({ where: { id: workflowRunId } })
    }

    const now = new Date()
    const summary = input.reason?.trim() || 'Workflow run cancelled.'

    // Atomic transition guarded on a non-terminal status: a concurrent cancel
    // or a run that completed between the check above and here writes nothing
    // (count === 0); either way we return the current row rather than
    // clobbering a terminal state — and skip the propagation, which the
    // winning transition already owns.
    const runTransition = await tx.workflowRun.updateMany({
      where: {
        id: workflowRunId,
        status: { in: ['pending', 'running'] },
      },
      data: {
        status: 'cancelled',
        summary,
        errorMessage: summary,
        finishedAt: now,
      },
    })

    if (runTransition.count > 0) {
      // Pending and blocked steps never started: plain skip.
      await tx.workflowStepRun.updateMany({
        where: {
          workflowRunId,
          status: { in: ['pending', 'blocked'] },
        },
        data: {
          status: 'skipped',
          finishedAt: now,
          errorMessage: summary,
        },
      })

      // Running steps are skipped individually: each records on its output
      // exactly what was abandoned, and each child kind gets its propagation.
      const runningSteps = await tx.workflowStepRun.findMany({
        where: { workflowRunId, status: 'running' },
        select: {
          agentRunId: true,
          environmentInstance: { select: { id: true } },
          id: true,
          output: true,
          stepType: true,
        },
      })

      for (const step of runningSteps) {
        const abandoned: Record<string, unknown> = {}
        let errorMessage = summary

        if (step.stepType === 'agent' && step.agentRunId) {
          // Cooperative cancellation (the runs.ts mechanism): the child
          // agentic loop observes cancelRequestedAt and terminalizes itself.
          await tx.run.updateMany({
            where: { id: step.agentRunId, status: 'running' },
            data: {
              cancelRequestedAt: now,
              cancelRequestedByUserId:
                actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null,
            },
          })
          // Name the queued mailbox message whose delivery this cancel
          // abandoned: the dispatch poller would otherwise keep claiming it
          // for a step that no longer exists.
          const abandonedMessage = await tx.agentMailboxMessage.findFirst({
            where: { workflowStepRunId: step.id, status: 'queued' },
            orderBy: [{ visibleAt: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          })
          if (abandonedMessage) {
            abandoned['cancelAbandonedMessageId'] = abandonedMessage.id
          }
        }

        if (step.stepType === 'environment_launch' && step.environmentInstance) {
          const payload: ExecutionEnvironmentTerminateJobPayload = {
            actorContext,
            instanceId: step.environmentInstance.id,
          }
          await enqueueQueueJob(tx, {
            idempotencyKey: `execution-environment:terminate:${step.environmentInstance.id}`,
            payload,
            topic: 'execution.environment.terminate',
          })
        }

        if (step.stepType === 'tool' || step.stepType === 'tool_call') {
          abandoned['cancelAbandonedAt'] = now.toISOString()
          errorMessage = `${summary} ${TOOL_STEP_CANCEL_NOTICE}`
        }

        const existingOutput =
          step.output && typeof step.output === 'object' && !Array.isArray(step.output)
            ? (step.output as Record<string, unknown>)
            : {}

        await tx.workflowStepRun.update({
          where: { id: step.id },
          data: {
            status: 'skipped',
            finishedAt: now,
            errorMessage,
            output: { ...existingOutput, ...abandoned } as Prisma.InputJsonValue,
          },
        })
      }
    }

    return tx.workflowRun.findUnique({ where: { id: workflowRunId } })
  })

  return result ? mapWorkflowRun(result) : null
}

type WorkflowRunStatusValue = 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
type WorkflowStepRunStatusValue =
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'pending'
  | 'running'
  | 'skipped'

export const isTerminalWorkflowRunStatus = (status: WorkflowRunStatusValue): boolean =>
  status === 'cancelled' || status === 'completed' || status === 'failed'

export const isActiveWorkflowRunStatus = (status: WorkflowRunStatusValue): boolean =>
  status === 'pending' || status === 'running'

export const canRetryWorkflowRun = (status: WorkflowRunStatusValue): boolean =>
  isTerminalWorkflowRunStatus(status)

export const canSkipWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean =>
  isActiveWorkflowRunStatus(input.runStatus) &&
  (input.stepStatus === 'pending' || input.stepStatus === 'blocked')

export const canBlockWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean => isActiveWorkflowRunStatus(input.runStatus) && input.stepStatus === 'pending'

export const canUnblockWorkflowStepRun = (input: {
  runStatus: WorkflowRunStatusValue
  stepStatus: WorkflowStepRunStatusValue
}): boolean => isActiveWorkflowRunStatus(input.runStatus) && input.stepStatus === 'blocked'

export class WorkflowActionError extends Error {
  constructor(
    public code:
      | 'WORKFLOW_RUN_NOT_TERMINAL'
      | 'WORKFLOW_INSTALLATION_INACTIVE'
      | 'WORKFLOW_RUN_NOT_ACTIVE'
      | 'WORKFLOW_STEP_RUN_NOT_SKIPPABLE'
      | 'WORKFLOW_STEP_RUN_NOT_BLOCKABLE'
      | 'WORKFLOW_STEP_RUN_NOT_UNBLOCKABLE',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowActionError'
  }
}

export const retryWorkflowRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  input: { reason?: string } = {},
): Promise<WorkflowRunRecord | null> => {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.workflowRun.findFirst({
      where: {
        id: workflowRunId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: {
        id: true,
        status: true,
        input: true,
        installationId: true,
        triggerDeliveryId: true,
        triggerId: true,
      },
    })
    if (!existing) {
      return null
    }
    if (!canRetryWorkflowRun(existing.status)) {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_NOT_TERMINAL',
        'Only terminal workflow runs can be retried',
      )
    }

    const installation = await tx.workflowInstallation.findFirst({
      where: {
        id: existing.installationId,
        organizationId: actorContext.tenant.organizationId,
        active: true,
        status: { in: ['active', 'draft'] },
      },
      select: { id: true, organizationId: true },
    })
    if (!installation) {
      throw new WorkflowActionError(
        'WORKFLOW_INSTALLATION_INACTIVE',
        'Workflow installation is inactive and cannot accept retries',
      )
    }

    const summary = input.reason?.trim() || `Retry of workflow run ${existing.id}`

    const run = await tx.workflowRun.create({
      data: {
        installationId: installation.id,
        organizationId: installation.organizationId,
        triggerId: existing.triggerId,
        triggerDeliveryId: existing.triggerDeliveryId,
        retriedFromWorkflowRunId: existing.id,
        graphSnapshot: await resolveInstallationPinnedGraph(tx, installation.id),
        input: (existing.input ?? {}) as Prisma.InputJsonValue,
        summary,
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

type StepActionContext = {
  prisma: PrismaClient
  actorContext: AuthorizedActionContext
  workflowStepRunId: string
  reason?: string
}

type StepRunSelection = {
  id: string
  status: 'blocked' | 'completed' | 'failed' | 'pending' | 'running' | 'skipped'
  workflowRun: {
    id: string
    organizationId: string
    status: 'cancelled' | 'completed' | 'failed' | 'pending' | 'running'
  }
}

const loadWorkflowStepRunForAction = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  workflowStepRunId: string,
): Promise<StepRunSelection | null> => {
  const row = await tx.workflowStepRun.findFirst({
    where: {
      id: workflowStepRunId,
      workflowRun: { organizationId },
    },
    select: {
      id: true,
      status: true,
      workflowRun: {
        select: {
          id: true,
          organizationId: true,
          status: true,
        },
      },
    },
  })
  return row
}

const enqueueWorkflowExecute = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  workflowRunId: string,
  suffix: string,
): Promise<void> => {
  const payload: WorkflowRunExecuteJobPayload = {
    actorContext,
    workflowRunId,
  }
  await enqueueQueueJob(tx, {
    idempotencyKey: `workflow-run:${suffix}:${workflowRunId}:${Date.now()}`,
    payload,
    topic: 'workflow.run.execute',
  })
}

export const skipWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canSkipWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_SKIPPABLE',
        'Only pending or blocked steps can be skipped',
      )
    }

    const summary = ctx.reason?.trim() || 'Workflow step skipped by operator.'
    // Atomic transition: guard on the skippable statuses so a concurrent
    // skip/block/execution write cannot be clobbered. count === 0 means the
    // step already moved on; return its current row without re-enqueuing.
    const { count } = await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: { in: ['pending', 'blocked'] },
      },
      data: {
        status: 'skipped',
        errorMessage: summary,
        finishedAt: new Date(),
      },
    })

    const updated = await tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })

    if (count > 0) {
      await enqueueWorkflowExecute(tx, ctx.actorContext, existing.workflowRun.id, 'step-skip')
    }

    return updated
  })

  return result ? mapWorkflowStepRun(result) : null
}

export const blockWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canBlockWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_BLOCKABLE',
        'Only pending steps can be blocked',
      )
    }

    const summary = ctx.reason?.trim() || 'Workflow step blocked by operator.'
    // Atomic transition guarded on `status === 'pending'`; a concurrent
    // block/skip/execution write that already moved the step leaves count === 0
    // and we just return the current row.
    await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: 'pending',
      },
      data: {
        status: 'blocked',
        errorMessage: summary,
      },
    })

    return tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })
  })

  return result ? mapWorkflowStepRun(result) : null
}

export const unblockWorkflowStepRun = async (
  ctx: StepActionContext,
): Promise<WorkflowStepRunRecord | null> => {
  const result = await ctx.prisma.$transaction(async (tx) => {
    const existing = await loadWorkflowStepRunForAction(
      tx,
      ctx.actorContext.tenant.organizationId,
      ctx.workflowStepRunId,
    )
    if (!existing) {
      return null
    }
    if (
      !canUnblockWorkflowStepRun({
        runStatus: existing.workflowRun.status,
        stepStatus: existing.status,
      })
    ) {
      if (!isActiveWorkflowRunStatus(existing.workflowRun.status)) {
        throw new WorkflowActionError('WORKFLOW_RUN_NOT_ACTIVE', 'Workflow run is not active')
      }
      throw new WorkflowActionError(
        'WORKFLOW_STEP_RUN_NOT_UNBLOCKABLE',
        'Only blocked steps can be unblocked',
      )
    }

    // Atomic transition guarded on `status === 'blocked'`. count === 0 means a
    // concurrent unblock/skip already moved the step; skip the re-enqueue and
    // return the current row.
    const { count } = await tx.workflowStepRun.updateMany({
      where: {
        id: ctx.workflowStepRunId,
        status: 'blocked',
      },
      data: {
        status: 'pending',
        errorMessage: null,
      },
    })

    const updated = await tx.workflowStepRun.findUnique({
      where: { id: ctx.workflowStepRunId },
      include: {
        environmentInstance: { select: { id: true } },
      },
    })

    if (count > 0) {
      await enqueueWorkflowExecute(tx, ctx.actorContext, existing.workflowRun.id, 'step-unblock')
    }

    return updated
  })

  return result ? mapWorkflowStepRun(result) : null
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
