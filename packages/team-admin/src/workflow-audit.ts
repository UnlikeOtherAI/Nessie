import type { PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
import type { AuthorizedActionContext } from '@nessie/schemas'

type WorkflowAuditAction =
  | 'workflow.installation.installed'
  | 'workflow.installation.updated'
  | 'workflow.run.cancelled'
  | 'workflow.run.retried'
  | 'workflow.run.started'
  | 'workflow.step_run.blocked'
  | 'workflow.step_run.skipped'
  | 'workflow.step_run.unblocked'
  | 'workflow.template.created'
  | 'workflow.template.updated'
  | 'workflow.trigger.created'

/** A workflow mutation is auditable no matter whether it began in Admin or chat. */
export const auditWorkflowMutation = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    action: WorkflowAuditAction
    metadata?: Record<string, unknown>
    resourceId: string
    resourceType:
      | 'workflow_installation'
      | 'workflow_run'
      | 'workflow_step_run'
      | 'workflow_template'
      | 'workflow_trigger'
    status?: string
  },
): Promise<void> => {
  try {
    await writeAuditEntry(prisma, {
      organizationId: actorContext.tenant.organizationId,
      projectId: actorContext.tenant.projectId ?? null,
      teamId: actorContext.tenant.teamId ?? null,
      channelId: actorContext.actionContext.channelId ?? null,
      actorType: actorContext.actor.actorType as 'agent' | 'service' | 'system' | 'user',
      actorId: actorContext.actor.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: 'success',
      metadata: {
        ...(input.status ? { status: input.status } : {}),
        ...input.metadata,
      },
      requestId: actorContext.actionContext.requestId,
    })
  } catch {
    // Audit must not roll back a valid workflow mutation.
    console.error('[audit] Failed to emit workflow audit event:', input.action, input.resourceType)
  }
}
