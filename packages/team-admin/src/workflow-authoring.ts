import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { isWorkflowConcurrencyConfig } from './workflow-concurrency.js'
import type { WorkflowGraphForValidation } from './workflow-template-validation.js'
import { validateWorkflowGraph } from './workflow-template-validation.js'
import {
  validateWorkflowSecretWrite,
  WORKFLOW_SECRET_WRITE_ERROR,
  type WorkflowBindingSecretError,
} from './workflow-secrets.js'

export type WorkflowTemplateAuthoringInput = {
  bindingSchema?: unknown
  description?: string
  graph: WorkflowGraphForValidation
  name: string
  requiredEnvironmentTemplateIds?: string[]
  triggers?: unknown
  variableSchema?: unknown
}

export type WorkflowInstallationAuthoringInput = {
  active?: boolean
  channelId?: string
  concurrency?: Record<string, unknown>
  config?: Record<string, unknown>
  resolvedBindings?: Record<string, unknown>
  status?: 'active' | 'disabled' | 'draft' | 'paused'
}

export class WorkflowTemplateValidationError extends Error {
  constructor(readonly issues: string[]) {
    super('WORKFLOW_TEMPLATE_INVALID')
    this.name = 'WorkflowTemplateValidationError'
  }
}

export class WorkflowSecretWriteError extends Error {
  constructor(readonly violations: WorkflowBindingSecretError[]) {
    super(WORKFLOW_SECRET_WRITE_ERROR)
    this.name = 'WorkflowSecretWriteError'
  }
}

export class WorkflowInstallationLifecycleError extends Error {
  constructor() {
    super('WORKFLOW_INSTALLATION_STATUS_CONFLICT')
    this.name = 'WorkflowInstallationLifecycleError'
  }
}

export class WorkflowTemplateAdoptionRequiredError extends Error {
  constructor() {
    super('WORKFLOW_TEMPLATE_ADOPTION_REQUIRED')
    this.name = 'WorkflowTemplateAdoptionRequiredError'
  }
}

const validateEnvironmentTemplateIds = async (
  prisma: PrismaClient,
  organizationId: string,
  templateIds: string[],
): Promise<void> => {
  if (templateIds.length === 0) return

  const count = await prisma.executionEnvironmentTemplate.count({
    where: { id: { in: templateIds }, organizationId },
  })
  if (count !== templateIds.length) {
    throw new Error('WORKFLOW_TEMPLATE_ENVIRONMENT_TEMPLATE_NOT_FOUND')
  }
}

const validateInstallationChannel = async (
  prisma: PrismaClient,
  organizationId: string,
  channelId: string | undefined,
): Promise<void> => {
  if (!channelId) return

  const channel = await prisma.channel.findFirst({
    where: { id: channelId, organizationId, systemChannelType: null },
    select: { id: true },
  })
  if (!channel) throw new Error('WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')
}

const resolveInstallationLifecycle = (input: {
  active?: boolean
  status?: WorkflowInstallationAuthoringInput['status']
}): { active: boolean; status: NonNullable<WorkflowInstallationAuthoringInput['status']> } | null => {
  const status = input.status ?? (input.active === false ? 'paused' : 'active')
  const active = status === 'disabled' ? false : (input.active ?? status !== 'paused')
  return (status === 'active' && !active) || (status !== 'active' && active)
    ? null
    : { active, status }
}

/**
 * The create path shared by the Admin route and the Personal Assistant. It
 * owns validation and tenancy checks; HTTP shapes its row for its response.
 */
export const createWorkflowTemplateForActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: WorkflowTemplateAuthoringInput,
) => {
  const issues = await validateWorkflowGraph(prisma, actorContext, input.graph)
  if (issues.length > 0) throw new WorkflowTemplateValidationError(issues)
  await validateEnvironmentTemplateIds(
    prisma,
    actorContext.tenant.organizationId,
    input.requiredEnvironmentTemplateIds ?? [],
  )

  return prisma.workflowTemplate.create({
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
      source: 'authored',
      createdByActorType: actorContext.actor.actorType,
      createdByActorId: actorContext.actor.actorId,
    },
  })
}

/**
 * The install path shared by the Admin route and the Personal Assistant. A
 * caller cannot bypass pinning, lifecycle validation, channel tenancy, or the
 * secret write boundary by choosing the conversational route.
 */
export const installWorkflowTemplateForActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowTemplateId: string,
  input: WorkflowInstallationAuthoringInput,
) => {
  const lifecycle = resolveInstallationLifecycle(input)
  if (!lifecycle) throw new WorkflowInstallationLifecycleError()
  if (input.concurrency !== undefined && !isWorkflowConcurrencyConfig(input.concurrency)) {
    throw new Error('WORKFLOW_CONCURRENCY_INVALID')
  }
  await validateInstallationChannel(
    prisma,
    actorContext.tenant.organizationId,
    input.channelId,
  )

  return prisma.$transaction(async (tx) => {
    const template = await tx.workflowTemplate.findFirst({
      where: { id: workflowTemplateId, organizationId: actorContext.tenant.organizationId },
      select: {
        adoptedAt: true,
        bindingSchema: true,
        graphJson: true,
        id: true,
        source: true,
        version: true,
      },
    })
    if (!template) return null
    if (template.source === 'demonstration' && !template.adoptedAt) {
      throw new WorkflowTemplateAdoptionRequiredError()
    }

    const violations = validateWorkflowSecretWrite({
      bindingSchema: template.bindingSchema,
      config: input.config,
      resolvedBindings: input.resolvedBindings,
    })
    if (violations.length > 0) throw new WorkflowSecretWriteError(violations)

    const installation = await tx.workflowInstallation.create({
      data: {
        workflowTemplateId: template.id,
        workflowTemplateVersion: template.version,
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
}
