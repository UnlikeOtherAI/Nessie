import { Prisma, type PrismaClient } from '@prisma/client'
import { WORKFLOW_TOOL_IDS } from '@nessie/runtime'
import {
  WORKFLOW_OVERLAP_SKIP_REASON,
  WORKFLOW_SECRET_WRITE_ERROR,
  admitWorkflowRunUnderOverlap,
  collectWorkflowStepReferences,
  collectWorkflowTaintedRefs,
  compileWorkflowJmespath,
  isWorkflowConcurrencyConfig,
  parseWorkflowBindingTemplate,
  parseWorkflowConcurrency,
  redactWorkflowInstallationSecrets,
  redactWorkflowSecretValues,
  releaseNextQueuedWorkflowRun,
  resolveInstallationPinnedGraph,
  validateWorkflowSecretWrite,
  withWorkflowOverlapLock,
  type WorkflowBindingSecretError,
} from '@nessie/workspace-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
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
  /** W0: per-binding literal/reference declaration from the owning template. */
  bindingSchema?: unknown
  channelId: string | null
  concurrency?: unknown
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

const parseWorkflowGraph = (value: unknown): WorkflowGraph =>
  WorkflowGraphSchema.parse(value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const parseUuidArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []

/**
 * Save-time validation of workflow graph steps against what the worker
 * runtime actually executes (`worker/src/control/workflows.ts`). Anything
 * rejected here would otherwise fail the run at execution time. `{{ … }}`
 * binding tokens are resolved at run time, so literal checks apply only when
 * the value is not an exact single-token binding — but every binding is
 * parsed (syntax must be valid) and every `steps.<id>` reference must name a
 * step that exists AND precedes the referencing step in execution order
 * (W9): a typo is a save error, not a failed run. `channelId` is never
 * required because the runtime falls back to the installation's channel.
 */
// W0: public writes never store caller-chosen refs or plaintext into a
// reference binding (mirrors the MCP credential-ref rule). Thrown by the
// install/update paths; routes map it to 400.
export class WorkflowSecretWriteError extends Error {
  readonly violations: WorkflowBindingSecretError[]

  constructor(violations: WorkflowBindingSecretError[]) {
    super(WORKFLOW_SECRET_WRITE_ERROR)
    this.violations = violations
  }
}

export class WorkflowTemplateValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super('WORKFLOW_TEMPLATE_INVALID')
    this.issues = issues
  }
}

// W13: `trigger` is not an executable step type. Trigger nodes on the canvas
// are authoring markers only; real scheduling is an `AgentTrigger` created
// from the installation's Triggers surface, and the runtime never sees one.
const WORKFLOW_STEP_TYPES = new Set([
  'agent',
  'agent_task',
  'environment_launch',
  // W15: a deterministic channel write. Also reachable as a tool step with
  // toolName `message_send` (W12's WORKFLOW_TOOL_IDS is the tool allow-list);
  // this is the explicit step-type form.
  'message_send',
  'tool',
  'tool_call',
])

const collectStepBindingTemplates = (
  input: Record<string, unknown> | undefined,
): Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> => {
  const templates: Array<{ key: string; template: ReturnType<typeof parseWorkflowBindingTemplate> }> = []

  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const template = parseWorkflowBindingTemplate(value)
      if (template.kind !== 'literal') {
        templates.push({ key: path, template })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        visit(entry, path ? `${path}.${key}` : key)
      }
    }
  }

  if (input) {
    for (const [key, entry] of Object.entries(input)) {
      if (key === 'workflowDesigner') {
        continue
      }
      visit(entry, key)
    }
  }

  return templates
}

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
  const allStepIds = new Set(graph.steps.map((step) => step.id))
  const literalAgentIds = new Set<string>()

  for (const step of graph.steps) {
    const label = step.title?.trim() || step.id

    // W9: binding syntax is validated on EVERY step, and every `steps.<id>`
    // reference must name a step that exists and precedes this one — a typo
    // is a save error here, not a WORKFLOW_BINDING_NOT_FOUND mid-run.
    const priorStepIds = new Set(seenStepIds)
    for (const { key, template } of collectStepBindingTemplates(step.input)) {
      if (template.kind === 'invalid') {
        issues.push(`Step "${label}" has an invalid binding in "${key}": ${template.error}.`)
        continue
      }
      for (const token of collectWorkflowStepReferences(template)) {
        const reference = token.reference
        if (reference.kind !== 'steps') {
          continue
        }
        if (!priorStepIds.has(reference.stepId)) {
          issues.push(
            allStepIds.has(reference.stepId)
              ? `Step "${label}" references "${reference.stepId}" before it has run — steps can only bind earlier steps' output.`
              : `Step "${label}" references unknown step "${reference.stepId}" in "${key}".`,
          )
        }
      }
    }

    // W16: compile the `when:` guard at save time through the one evaluator
    // module — a bad predicate is a save error, never a mid-run surprise.
    if (typeof step.when === 'string' && step.when.trim()) {
      const whenError = compileWorkflowJmespath(step.when)
      if (whenError) {
        issues.push(`Step "${label}" has an invalid when guard: ${whenError}.`)
      }
    }

    if (seenStepIds.has(step.id)) {
      issues.push(`Duplicate step id "${step.id}" — step outputs would collide.`)
    }
    seenStepIds.add(step.id)

    if (!WORKFLOW_STEP_TYPES.has(step.type)) {
      issues.push(
        step.type === 'trigger'
          ? `Step "${label}" has type "trigger", which is not executable — scheduling is authored on the installation's Triggers page, not in the graph.`
          : `Step "${label}" has unsupported type "${step.type}". Supported: tool, agent, environment_launch, message_send.`,
      )
      continue
    }

    if (step.type === 'tool' || step.type === 'tool_call') {
      const toolName = readStepInputString(step.input, 'toolName')
      if (!toolName) {
        issues.push(`Tool step "${label}" is missing toolName.`)
      } else {
        const template = parseWorkflowBindingTemplate(toolName)
        // An exact single-token binding resolves to whatever the referenced
        // value holds — only a literal or inline-interpolated name can be
        // checked against the allow-list at save time.
        if (template.kind !== 'exact' && !WORKFLOW_TOOL_IDS.has(toolName)) {
          issues.push(
            `Tool step "${label}" uses unknown tool "${toolName}". Available: ${[...WORKFLOW_TOOL_IDS].sort().join(', ')}.`,
          )
        }
      }
    }

    if (step.type === 'agent' || step.type === 'agent_task') {
      const agentId = readStepInputString(step.input, 'agentId')
      if (!agentId) {
        issues.push(`Agent step "${label}" is missing agentId.`)
      } else if (parseWorkflowBindingTemplate(agentId).kind !== 'exact') {
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

    if (step.type === 'message_send') {
      const body = readStepInputString(step.input, 'body')
      // An exact single-token binding is checked at run time; everything else
      // (missing, empty literal) is a save error. channelId/threadId are
      // optional — the runtime falls back to the installation channel.
      if (!body) {
        issues.push(`Message step "${label}" is missing body.`)
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
  // W0 sink 1: redaction happens server-side in the response mapper, never
  // in the admin. Reference bindings render as the redaction marker.
  resolvedBindings: toJsonRecord(
    redactWorkflowInstallationSecrets(installation.resolvedBindings, installation.bindingSchema),
  ),
  config: toJsonRecord(
    redactWorkflowInstallationSecrets(installation.config, installation.bindingSchema),
  ),
  concurrency: parseWorkflowConcurrency(installation.concurrency),
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

export const WORKFLOW_LIST_PAGE_SIZE = 200

export type WorkflowListPage<T> = {
  items: T[]
  /** Id to pass back as `cursor`; null when this was the last page. */
  nextCursor: string | null
}

type WorkflowListInput = {
  cursor?: string
  limit?: number
}

const resolveWorkflowListLimit = (limit: number | undefined): number =>
  typeof limit === 'number' && Number.isInteger(limit) && limit > 0
    ? Math.min(limit, WORKFLOW_LIST_PAGE_SIZE)
    : WORKFLOW_LIST_PAGE_SIZE

export const listWorkflowTemplates = async (
  prisma: PrismaClient,
  organizationId: string,
  input: WorkflowListInput = {},
): Promise<WorkflowListPage<WorkflowTemplateRecord>> => {
  // The select includes `graphJson` deliberately: WorkflowGraphSchema
  // requires at least one step, so substituting an empty graph made this
  // endpoint 500 as soon as any template existed — and the admin list
  // renders step counts.
  const limit = resolveWorkflowListLimit(input.limit)
  const templates = await prisma.workflowTemplate.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
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

  const page = templates.slice(0, limit)
  return {
    items: page.map(mapWorkflowTemplate),
    nextCursor: templates.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
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

// W8: one installation lifecycle. The schema carries the legacy pair
// (`status`, `active`) and API, worker and UI used to read them differently,
// so a paused installation still fired. Every write goes through this
// derivation; every dispatch/read gate goes through the two helpers below,
// so a contradictory row can neither be written nor acted on.
const resolveWorkflowInstallationLifecycle = (input: {
  active?: boolean
  status?: WorkflowInstallationRecord['status']
}): { active: boolean; status: WorkflowInstallationRecord['status'] } | null => {
  const status = input.status ?? (input.active === false ? 'paused' : 'active')
  const active = status === 'disabled' ? false : (input.active ?? status !== 'paused')

  if (status === 'active' && !active) {
    return null // active-but-off: nothing may read that as runnable
  }
  if (status !== 'active' && active) {
    return null // paused/draft/disabled but flagged on: dispatch must not fire
  }
  return { active, status }
}

export class WorkflowInstallationLifecycleError extends Error {
  constructor() {
    super('WORKFLOW_INSTALLATION_STATUS_CONFLICT')
    this.name = 'WorkflowInstallationLifecycleError'
  }
}

export const isWorkflowInstallationRunnable = (installation: {
  active: boolean
  status: WorkflowInstallationRecord['status']
}): boolean => installation.status === 'active' && installation.active

export const isWorkflowInstallationStartable = (installation: {
  active: boolean
  status: WorkflowInstallationRecord['status']
}): boolean =>
  installation.active && (installation.status === 'active' || installation.status === 'draft')

// W0: the write gate. The install and update paths both validate caller
// JSON against the owning template's bindingSchema before persisting.
const assertWorkflowSecretWrite = (input: {
  bindingSchema: unknown
  config?: Record<string, unknown>
  resolvedBindings?: Record<string, unknown>
}): void => {
  const violations = validateWorkflowSecretWrite(input)
  if (violations.length > 0) {
    throw new WorkflowSecretWriteError(violations)
  }
}

export const installWorkflowTemplate = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowTemplateId: string,
  input: {
    active?: boolean
    channelId?: string
    concurrency?: Record<string, unknown>
    config?: Record<string, unknown>
    resolvedBindings?: Record<string, unknown>
    status?: WorkflowInstallationRecord['status']
  },
): Promise<WorkflowInstallationRecord | null> => {
  const lifecycle = resolveWorkflowInstallationLifecycle({
    active: input.active,
    status: input.status,
  })
  if (!lifecycle) {
    throw new WorkflowInstallationLifecycleError()
  }
  if (input.concurrency !== undefined && !isWorkflowConcurrencyConfig(input.concurrency)) {
    throw new WorkflowActionError(
      'WORKFLOW_CONCURRENCY_INVALID',
      'concurrency must be { limit?: integer >= 1, onOverlap?: skip | queue | parallel }',
    )
  }

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
        version: true,
        bindingSchema: true,
      },
    })
    if (!template) {
      return null
    }

    // W13: no trigger materialisation from triggersJson. Template
    // `triggersJson` is canvas position/authoring metadata only; a real
    // schedule is an AgentTrigger created through `createWorkflowTrigger`
    // from the installation's Triggers surface — one code path.
    // W0: validate against the template's bindingSchema before any write —
    // a plaintext value for a reference binding or a caller-chosen `secret_*`
    // ref anywhere else is rejected, mirroring the MCP credential-ref rule.
    assertWorkflowSecretWrite({
      bindingSchema: template.bindingSchema,
      config: input.config,
      resolvedBindings: input.resolvedBindings,
    })

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
        status: lifecycle.status,
        active: lifecycle.active,
        resolvedBindings: (input.resolvedBindings ?? {}) as Prisma.InputJsonValue,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        ...(input.concurrency !== undefined
          ? { concurrency: input.concurrency as Prisma.InputJsonValue }
          : {}),
        createdByActorType: actorContext.actor.actorType,
        createdByActorId: actorContext.actor.actorId,
      },
    })

    return { bindingSchema: template.bindingSchema, installation }
  })

  return result
    ? mapWorkflowInstallation({
        ...result.installation,
        bindingSchema: result.bindingSchema,
      })
    : null
}

// W8: there was no update-installation endpoint at all — status was
// write-once at install, so "paused" was unreachable. This is the pause /
// resume / disable / re-target path; the same lifecycle derivation as
// install applies, so contradictory active/status pairs are 409s here too.
export const updateWorkflowInstallation = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  installationId: string,
  input: {
    active?: boolean
    channelId?: string
    concurrency?: Record<string, unknown>
    config?: Record<string, unknown>
    resolvedBindings?: Record<string, unknown>
    status?: WorkflowInstallationRecord['status']
  },
): Promise<WorkflowInstallationRecord | null> => {
  const lifecycle = resolveWorkflowInstallationLifecycle({
    active: input.active,
    status: input.status,
  })
  if (!lifecycle) {
    throw new WorkflowInstallationLifecycleError()
  }
  if (input.concurrency !== undefined && !isWorkflowConcurrencyConfig(input.concurrency)) {
    throw new WorkflowActionError(
      'WORKFLOW_CONCURRENCY_INVALID',
      'concurrency must be { limit?: integer >= 1, onOverlap?: skip | queue | parallel }',
    )
  }

  await validateWorkflowInstallationChannel(
    prisma,
    actorContext.tenant.organizationId,
    input.channelId,
  )

  const existing = await prisma.workflowInstallation.findFirst({
    where: {
      id: installationId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: {
      id: true,
      workflowTemplate: { select: { bindingSchema: true } },
    },
  })
  if (!existing) {
    return null
  }

  assertWorkflowSecretWrite({
    bindingSchema: existing.workflowTemplate.bindingSchema,
    config: input.config,
    resolvedBindings: input.resolvedBindings,
  })

  const updated = await prisma.workflowInstallation.update({
    where: { id: existing.id },
    data: {
      status: lifecycle.status,
      active: lifecycle.active,
      ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
      ...(input.config !== undefined
        ? { config: input.config as Prisma.InputJsonValue }
        : {}),
      ...(input.resolvedBindings !== undefined
        ? { resolvedBindings: input.resolvedBindings as Prisma.InputJsonValue }
        : {}),
      ...(input.concurrency !== undefined
        ? { concurrency: input.concurrency as Prisma.InputJsonValue }
        : {}),
    },
  })

  return mapWorkflowInstallation({
    ...updated,
    bindingSchema: existing.workflowTemplate.bindingSchema,
  })
}

export const listWorkflowInstallations = async (
  prisma: PrismaClient,
  organizationId: string,
  input: WorkflowListInput = {},
): Promise<WorkflowListPage<WorkflowInstallationRecord>> => {
  const limit = resolveWorkflowListLimit(input.limit)
  const installations = await prisma.workflowInstallation.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: { workflowTemplate: { select: { bindingSchema: true } } },
  })

  const page = installations.slice(0, limit)
  return {
    items: page.map((installation) =>
      mapWorkflowInstallation({
        ...installation,
        bindingSchema: installation.workflowTemplate.bindingSchema,
      }),
    ),
    nextCursor: installations.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
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
  const result = await withWorkflowOverlapLock(prisma, installationId, async (tx) => {
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
        active: true,
        concurrency: true,
        id: true,
        organizationId: true,
        status: true,
      },
    })
    if (installation && !isWorkflowInstallationStartable(installation)) {
      // A contradictory legacy row (paused-but-active, disabled-but-active)
      // fails closed rather than starting a run.
      return null
    }
    if (!installation) {
      return null
    }

    await validateWorkflowRunReferences(tx, installation.organizationId, input)

    // W26: manual runs respect the same overlap policy as trigger fires —
    // enforcing only in the trigger path would be a trivial bypass. A skipped
    // admission throws so the route can answer 409 with the recorded reason;
    // a withheld one returns its pending run and is released by the active
    // run's terminal transition.
    const admission = await admitWorkflowRunUnderOverlap(tx, {
      concurrency: parseWorkflowConcurrency(installation.concurrency),
      installationId: installation.id,
    })
    if (admission.kind === 'skip') {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_OVERLAP_SKIPPED',
        `Workflow run skipped: the installation's overlap policy is at capacity (${WORKFLOW_OVERLAP_SKIP_REASON})`,
      )
    }

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
        ...(admission.kind === 'withhold'
          ? { summary: `${WORKFLOW_OVERLAP_SKIP_REASON}:queued` }
          : {}),
        startedByActorType: actorContext.actor.actorType,
        startedByActorId: actorContext.actor.actorId,
      },
    })

    if (admission.kind === 'admit') {
      const payload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: run.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${run.id}`,
        payload,
        topic: 'workflow.run.execute',
      })
    }

    return run
  })

  return result ? mapWorkflowRun(result) : null
}

export const listWorkflowRuns = async (
  prisma: PrismaClient,
  organizationId: string,
  input: {
    cursor?: string
    installationId?: string
    limit?: number
  },
): Promise<WorkflowListPage<WorkflowRunRecord>> => {
  // List view omits the large `input`/`output` Json blobs; they are only
  // fetched by the single-run GET. The contract still requires them, so the
  // list mapper substitutes empty objects.
  const limit = resolveWorkflowListLimit(input.limit)
  const runs = await prisma.workflowRun.findMany({
    where: {
      organizationId,
      ...(input.installationId ? { installationId: input.installationId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: limit + 1,
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

  const page = runs.slice(0, limit)
  return {
    items: page.map((run) => mapWorkflowRun({ ...run, input: {}, output: {} })),
    nextCursor: runs.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
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
  // The overlap lock keys on the installation; resolve it first (the
  // authoritative re-read happens inside the transaction).
  const cancelTarget = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: { installationId: true },
  })
  if (!cancelTarget) {
    return null
  }

  const result = await withWorkflowOverlapLock(prisma, cancelTarget.installationId, async (tx) => {
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
      // W26: the cancelled run freed the installation's slot; release one
      // withheld pending run and enqueue it inside the same lock.
      const released = await releaseNextQueuedWorkflowRun(tx, cancelTarget.installationId)
      if (released) {
        await enqueueQueueJob(tx, {
          idempotencyKey: `workflow-run:start:${released.id}`,
          payload: { workflowRunId: released.id },
          topic: 'workflow.run.execute',
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
      | 'WORKFLOW_STEP_RUN_NOT_UNBLOCKABLE'
      | 'WORKFLOW_CONCURRENCY_INVALID'
      | 'WORKFLOW_RUN_OVERLAP_SKIPPED',
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
  // The overlap lock keys on the installation, so resolve it first (the
  // authoritative re-read happens inside the transaction below).
  const runInstallation = await prisma.workflowRun.findFirst({
    where: {
      id: workflowRunId,
      organizationId: actorContext.tenant.organizationId,
    },
    select: { installationId: true },
  })
  if (!runInstallation) {
    return null
  }

  const result = await withWorkflowOverlapLock(prisma, runInstallation.installationId, async (tx) => {
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
        startedByActorId: true,
        startedByActorType: true,
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
      select: { concurrency: true, id: true, organizationId: true },
    })
    if (!installation) {
      throw new WorkflowActionError(
        'WORKFLOW_INSTALLATION_INACTIVE',
        'Workflow installation is inactive and cannot accept retries',
      )
    }

    // W26: a retry is a new run and takes the same overlap admission as any
    // other entrypoint.
    const admission = await admitWorkflowRunUnderOverlap(tx, {
      concurrency: parseWorkflowConcurrency(installation.concurrency),
      installationId: installation.id,
    })
    if (admission.kind === 'skip') {
      throw new WorkflowActionError(
        'WORKFLOW_RUN_OVERLAP_SKIPPED',
        `Workflow run retry skipped: the installation's overlap policy is at capacity (${WORKFLOW_OVERLAP_SKIP_REASON})`,
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
        summary: admission.kind === 'withhold'
          ? `${WORKFLOW_OVERLAP_SKIP_REASON}:queued`
          : summary,
        // W27: the retry must not rewrite history — the run keeps its
        // original starter; the retrying actor is recorded alongside.
        startedByActorType: existing.startedByActorType,
        startedByActorId: existing.startedByActorId,
        retriedByActorType: actorContext.actor.actorType,
        retriedByActorId: actorContext.actor.actorId,
        retriedAt: new Date(),
      },
    })

    if (admission.kind === 'admit') {
      const payload: WorkflowRunExecuteJobPayload = {
        actorContext,
        workflowRunId: run.id,
      }
      await enqueueQueueJob(tx, {
        idempotencyKey: `workflow-run:start:${run.id}`,
        payload,
        topic: 'workflow.run.execute',
      })
    }

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
    include: {
      installation: {
        select: {
          resolvedBindings: true,
          workflowTemplate: { select: { bindingSchema: true } },
        },
      },
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

  // W0 sinks 1+4: run JSON and persisted step artifacts (the §5 sample the
  // designer/replay reads) are redacted server-side. The boundary is the
  // response mapper, not the admin, so pre-boundary rows that already hold a
  // ref in `WorkflowStepRun.input` are covered too.
  const taintedRefs = collectWorkflowTaintedRefs(run.installation.resolvedBindings)
  const redactedRun: WorkflowRunRow = {
    ...run,
    input: redactWorkflowSecretValues(run.input, taintedRefs),
    output: redactWorkflowSecretValues(run.output, taintedRefs),
  }

  return {
    run: mapWorkflowRun(redactedRun),
    steps: steps.map((step) =>
      mapWorkflowStepRun({
        ...step,
        input: redactWorkflowSecretValues(step.input, taintedRefs),
        output: redactWorkflowSecretValues(step.output, taintedRefs),
      }),
    ),
  }
}
