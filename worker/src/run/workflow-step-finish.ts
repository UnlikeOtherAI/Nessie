import type { PrismaClient } from '@prisma/client'

import {
  buildWorkflowRunEventContext,
  emitWorkflowRunTerminalEvent,
  postWorkflowRunCard,
  type WorkflowGraphForEvents,
} from '../control/workflow-run-events.js'
import {
  markWorkflowRunFinished as markWorkflowRunFinishedRaw,
  markWorkflowStepRunFinished as markWorkflowStepRunFinishedRaw,
  type WorkflowStepFinishResult,
} from './workflows.js'

// Emitting seam for the run/workflows.js terminal primitives: every place a
// workflow run can reach a terminal state (a step failure, which always fails
// the run per computeWorkflowStepFinishTransition, or the last step
// completing) must also emit the `workflow.run.completed` /
// `workflow.run.failed` system event. The async continuations (parent
// agent-task completion, environment-instance completion) live in run/ and
// control/execution, so this seam lives here — run/ has no dependency on
// control/workflows.js. Safe to call from multiple sites for the same run:
// the dedupe key in emitWorkflowRunTerminalEvent collapses duplicate
// enqueues, and the guarded transition in the raw primitive reports
// `applied: false` once the run is already terminal.

export const finishWorkflowStepRun = async (
  prisma: PrismaClient,
  workflow: WorkflowGraphForEvents,
  input: {
    output?: Record<string, unknown>
    stepRunId?: string | null
    success: boolean
    summary?: string
    workflowRunId?: string | null
  },
): Promise<WorkflowStepFinishResult> => {
  const result = await markWorkflowStepRunFinishedRaw(prisma, input)

  // The run already had a terminal status when the write was attempted — a
  // concurrent terminalization owns the terminal event (or it already fired).
  // Emitting here would report a transition that did not happen.
  if (!result.applied) {
    return result
  }

  if (!input.success) {
    await emitWorkflowRunTerminalEvent(
      prisma,
      buildWorkflowRunEventContext(workflow),
      'failed',
      input.summary,
    )
    // W21: the failure card in the origin channel.
    await postWorkflowRunCard(prisma, workflow, 'failed')
  } else if (result.workflowRunCompleted) {
    await emitWorkflowRunTerminalEvent(prisma, buildWorkflowRunEventContext(workflow), 'completed')
    await postWorkflowRunCard(prisma, workflow, 'completed')
  }

  return result
}

export const finishWorkflowRun = async (
  prisma: PrismaClient,
  workflow: WorkflowGraphForEvents,
  input: {
    output?: Record<string, unknown>
    success: boolean
    summary?: string
    workflowRunId: string
  },
): Promise<{ applied: boolean }> => {
  const result = await markWorkflowRunFinishedRaw(prisma, input)

  if (!result.applied) {
    return result
  }

  await emitWorkflowRunTerminalEvent(
    prisma,
    buildWorkflowRunEventContext(workflow),
    input.success ? 'completed' : 'failed',
    input.summary,
  )
  await postWorkflowRunCard(prisma, workflow, input.success ? 'completed' : 'failed')

  return result
}
