import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  validateWorkflowGraph,
  validateWorkflowSecretWrite,
  WorkflowSecretWriteError,
  WorkflowTemplateValidationError,
} from '@nessie/team-admin'

import type { WorkflowGraph } from '../contracts/workflows.js'
export { WorkflowSecretWriteError, WorkflowTemplateValidationError }

/**
 * Save-time validation of workflow graph steps against the worker's actual
 * executors. The same function is also used by demonstration generalization,
 * so a learned draft cannot bypass binding, JMESPath, or live-agent checks.
 */
export const validateWorkflowGraphSteps = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  graph: WorkflowGraph,
): Promise<void> => {
  const issues = await validateWorkflowGraph(prisma, actorContext, graph)
  if (issues.length > 0) throw new WorkflowTemplateValidationError(issues)
}

export const assertWorkflowSecretWrite = (input: {
  bindingSchema: unknown
  config?: Record<string, unknown>
  resolvedBindings?: Record<string, unknown>
}): void => {
  const violations = validateWorkflowSecretWrite(input)
  if (violations.length > 0) throw new WorkflowSecretWriteError(violations)
}

// This error family lives beside validation rather than the run services:
// installation, run creation, and step-run actions share its typed outcomes.
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
