import type { RunExecuteJobPayload } from '@nessie/schemas'
import { enqueueQueueJob } from '../../queue.js'
import { markWorkflowStepRunFinished } from '../workflows.js'
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
  const result = await markWorkflowStepRunFinished(deps.prisma, {
    output: input.output,
    stepRunId: payload.parentWorkflowStepRunId,
    success: input.success,
    summary: input.summary,
    workflowRunId: payload.parentWorkflowRunId,
  })

  if (!result.continueWorkflow || !payload.parentWorkflowRunId) {
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
