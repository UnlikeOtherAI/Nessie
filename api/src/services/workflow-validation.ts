import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  validateWorkflowGraph,
  validateWorkflowSecretWrite,
  WORKFLOW_SECRET_WRITE_ERROR,
  type WorkflowBindingSecretError,
} from '@nessie/team-admin'

import type { WorkflowGraph } from '../contracts.js'

/** The typed API rejection for the shared save-time Workflow graph validator. */
export class WorkflowTemplateValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super('WORKFLOW_TEMPLATE_INVALID')
    this.issues = issues
  }
}

// W0: public writes never store caller-chosen refs or plaintext into a
// reference binding. The install/update paths map this typed rejection to 400.
export class WorkflowSecretWriteError extends Error {
  readonly violations: WorkflowBindingSecretError[]

  constructor(violations: WorkflowBindingSecretError[]) {
    super(WORKFLOW_SECRET_WRITE_ERROR)
    this.violations = violations
  }
}

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
