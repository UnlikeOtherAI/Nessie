import { Prisma, type PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  validateWorkflowEnvironmentTemplateIds,
  WorkflowTemplateValidationError,
  type WorkflowTemplateAuthoringInput,
} from './workflow-authoring.js'
import { validateWorkflowGraph } from './workflow-template-validation.js'

/**
 * A template edit is shared by the Admin route and the PA. Keeping optimistic
 * versioning here means a conversational edit cannot overwrite an Admin edit
 * that the route would reject.
 */
export class WorkflowTemplateVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Workflow template version conflict')
    this.name = 'WorkflowTemplateVersionConflictError'
  }
}

export const updateWorkflowTemplateForActor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  workflowTemplateId: string,
  input: WorkflowTemplateAuthoringInput,
  expectedVersion?: number,
) => {
  const issues = await validateWorkflowGraph(prisma, actorContext, input.graph)
  if (issues.length > 0) throw new WorkflowTemplateValidationError(issues)
  await validateWorkflowEnvironmentTemplateIds(
    prisma,
    actorContext.tenant.organizationId,
    input.requiredEnvironmentTemplateIds ?? [],
  )

  const data = {
    name: input.name,
    description: input.description,
    version: { increment: 1 },
    graphJson: input.graph as unknown as Prisma.InputJsonValue,
    triggersJson: (input.triggers ?? {}) as Prisma.InputJsonValue,
    variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
    bindingSchema: (input.bindingSchema ?? {}) as Prisma.InputJsonValue,
    requiredEnvironmentTemplateIds:
      (input.requiredEnvironmentTemplateIds ?? []) as unknown as Prisma.InputJsonValue,
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.workflowTemplate.updateMany({
      where: {
        id: workflowTemplateId,
        organizationId: actorContext.tenant.organizationId,
        ...(expectedVersion === undefined ? {} : { version: expectedVersion }),
      },
      data,
    })
    if (updated.count === 0) {
      const existing = await tx.workflowTemplate.findFirst({
        where: { id: workflowTemplateId, organizationId: actorContext.tenant.organizationId },
        select: { version: true },
      })
      if (!existing) return null
      throw new WorkflowTemplateVersionConflictError(existing.version)
    }

    const template = await tx.workflowTemplate.findFirst({
      where: { id: workflowTemplateId, organizationId: actorContext.tenant.organizationId },
    })
    if (!template) throw new Error('WORKFLOW_TEMPLATE_UPDATE_LOST')
    return template
  })
}
