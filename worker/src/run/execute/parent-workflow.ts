import type { RunExecuteJobPayload } from '@nessie/schemas'
import { enqueueQueueJob } from '../../queue.js'
import { loadWorkflowGraph } from '../workflows.js'
import { finishWorkflowStepRun } from '../workflow-step-finish.js'
import type { ExecutionDependencies } from './types.js'

export const maybeContinueParentWorkflow = async (
  deps: Pick<ExecutionDependencies, 'prisma'>,
  payload: RunExecuteJobPayload,
  input: {
    output?: Record<string, unknown>
    success: boolean
    summary?: string
  },
): Promise<void> => {
  if (!payload.parentWorkflowRunId) {
    return
  }

  const workflow = await loadWorkflowGraph(deps.prisma, payload.parentWorkflowRunId)
  if (!workflow) {
    return
  }

  // Finish through the emitting seam so a final asynchronous step fires the
  // workflow.run.completed / workflow.run.failed event. `applied: false` (a
  // concurrent cancel or sibling failure won) reports continueWorkflow:
  // false, so the continuation enqueue below is skipped automatically.
  const result = await finishWorkflowStepRun(deps.prisma, workflow, {
    output: input.output,
    stepRunId: payload.parentWorkflowStepRunId,
    success: input.success,
    summary: input.summary,
    workflowRunId: payload.parentWorkflowRunId,
  })

  if (!result.continueWorkflow) {
    return
  }

  await enqueueQueueJob(deps.prisma, {
    idempotencyKey: `workflow-run:continue:${payload.parentWorkflowRunId}:${payload.parentWorkflowStepRunId}`,
    payload: {
      actorContext: payload.actorContext,
      workflowRunId: payload.parentWorkflowRunId,
    },
    topic: 'workflow.run.execute',
  })
}
