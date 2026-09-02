import { Prisma, type PrismaClient } from '@prisma/client'
import { isWorkflowConcurrencyConfig } from '@nessie/workspace-admin'
import type { AuthorizedActionContext } from '@nessie/schemas'

import type {
  WorkflowGraph,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../contracts.js'
import {
  mapWorkflowInstallation,
  mapWorkflowTemplate,
  resolveWorkflowListLimit,
  type WorkflowListInput,
  type WorkflowListPage,
} from './workflow-records.js'
import {
  validateRequiredEnvironmentTemplateIds,
  validateWorkflowInstallationChannel,
} from './workflow-references.js'
import {
  assertWorkflowSecretWrite,
  validateWorkflowGraphSteps,
  WorkflowActionError,
} from './workflow-validation.js'

// Authoring surface: the workflow template CRUD and the installation that
// pins a template version into an organization. Executing an installation is
// workflow-runs.ts; this module never starts work.

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
      source: true,
      demonstrationId: true,
      adoptedAt: true,
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
    actorContext,
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
      source: 'authored',
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

/**
 * The caller's `If-Match` version is not the row's current one: a second editor
 * saved in between. Never resolved by taking the last write — the choice is the
 * person's (docs/navigation.md → "Drafts").
 */
export class WorkflowTemplateVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Workflow template version conflict')
    this.name = 'WorkflowTemplateVersionConflictError'
  }
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
  // The version the caller edited, from `If-Match`. Undefined = no opinion.
  expectedVersion?: number,
): Promise<WorkflowTemplateRecord | null> => {
  await validateWorkflowGraphSteps(
    prisma,
    actorContext,
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

  if (expectedVersion !== undefined && existingTemplate.version !== expectedVersion) {
    throw new WorkflowTemplateVersionConflictError(existingTemplate.version)
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

export class WorkflowTemplateAdoptionRequiredError extends Error {
  constructor() {
    super('WORKFLOW_TEMPLATE_ADOPTION_REQUIRED')
    this.name = 'WorkflowTemplateAdoptionRequiredError'
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
        source: true,
        adoptedAt: true,
      },
    })
    if (!template) {
      return null
    }

    // A human-created learned draft is marked adopted when it is generated.
    // An agent-proposed one reaches this point only after the approval effect
    // writes its durable adoptedAt decision; a raw trace is never runnable.
    if (template.source === 'demonstration' && !template.adoptedAt) {
      throw new WorkflowTemplateAdoptionRequiredError()
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
  input: WorkflowListInput & {
    channelId?: string
    // W19: entitlement fragment from workflow-entitlement.ts; undefined means
    // "no additional filter" (owners/admins).
    entitlementWhere?: Prisma.WorkflowInstallationWhereInput
  } = {},
): Promise<WorkflowListPage<WorkflowInstallationRecord>> => {
  const limit = resolveWorkflowListLimit(input.limit)
  const installations = await prisma.workflowInstallation.findMany({
    where: {
      organizationId,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.entitlementWhere ?? {}),
    },
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
