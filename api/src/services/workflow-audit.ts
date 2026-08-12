import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { emitAuditEvent } from './audit.js'

/**
 * W22 — every workflow route mutation writes an audit entry through the
 * shared audit service (no second audit path). The actor is the caller's own
 * context: a retry therefore audits the *retrying* actor even though W27
 * keeps the new run's original starter — history is not rewritten and the log
 * still says who acted.
 *
 * Emission failures never roll back the primary mutation (emitAuditEvent's
 * own guarantee).
 */

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

export const auditWorkflowMutation = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    action: WorkflowAuditAction
    metadata?: Record<string, unknown>
    resourceId: string
    resourceType: 'workflow_installation' | 'workflow_run' | 'workflow_step_run' | 'workflow_template'
    status?: string
  },
): Promise<void> => {
  await emitAuditEvent(prisma, {
    actorContext,
    action: input.action,
    metadata: {
      ...(input.status ? { status: input.status } : {}),
      ...input.metadata,
    },
    outcome: 'success',
    resourceId: input.resourceId,
    resourceType: input.resourceType,
  })
}
