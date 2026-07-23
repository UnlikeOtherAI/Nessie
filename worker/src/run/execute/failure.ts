import { parseAgentId, parseRunId, type RunExecuteJobPayload } from '@nessie/schemas'
import { markDelegationStepFinished, markRunPlanFinished } from '../plans.js'
import { buildScopes } from './scopes.js'
import { updateRunStatus, updateTaskStatus, setAgentStatus } from './lifecycle.js'
import { maybeContinueParentWorkflow } from './parent-workflow.js'
import { publishAgentStatus, publishMessageCreated, publishRunUpdated, publishTaskUpdated } from './realtime.js'
import type { ExecutionDependencies, RunContext, RunPlanContext } from './types.js'

export const handleRunExecutionFailure = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: {
    error: unknown
    planContext: RunPlanContext | null
    streamStarted: boolean
    // Overrides the default "I hit an error…" reply for terminal outcomes that
    // are not crashes — e.g. a budget-cap stop that produced no partial answer,
    // which posts a clear "stopped at the limit" notice instead.
    terminalMessage?: string
  },
): Promise<void> => {
  const messageText =
    input.error instanceof Error ? input.error.message : 'Run execution failed unexpectedly'

  if (input.streamStarted) {
    const fallbackMessageId = `run-error:${context.run.id}`
    let terminalMessageId = fallbackMessageId
    let terminalContent =
      input.terminalMessage ?? `I hit an error while processing this request: ${messageText}`
    let terminalCreatedAt = new Date().toISOString()

    try {
      const errorMessage = await deps.prisma.message.create({
        data: {
          agentId: context.agent.id,
          content: terminalContent,
          role: 'assistant',
          threadId: context.run.threadId,
        },
      })

      terminalMessageId = errorMessage.id
      terminalContent = errorMessage.content
      terminalCreatedAt = errorMessage.createdAt.toISOString()

      await publishMessageCreated(deps.realtimeTransport, context, {
        content: errorMessage.content,
        messageId: errorMessage.id,
        role: errorMessage.role,
      })
    } catch (streamError) {
      console.error('Failed to persist terminal error message', streamError)
    }

    try {
      await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
        agentId: parseAgentId(context.agent.id),
        content: terminalContent,
        createdAt: terminalCreatedAt,
        messageId: terminalMessageId,
        runId: parseRunId(context.run.id),
      })
    } catch (streamError) {
      console.error('Failed to publish terminal stream event', streamError)
    }
  }

  await updateRunStatus(deps.prisma, context.run.id, 'failed')
  await updateTaskStatus(deps.prisma, context.task.id, 'failed')
  if (input.planContext) {
    await markRunPlanFinished(deps.prisma, {
      artifacts: {
        error: messageText,
      },
      planId: input.planContext.planId,
      rootStepId: input.planContext.rootStepId,
      success: false,
      summary: messageText.slice(0, 500),
    })
  }
  await markDelegationStepFinished(deps.prisma, {
    artifacts: {
      error: messageText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    planId: payload.parentPlanId,
    planStepId: payload.parentPlanStepId,
    success: false,
    summary: messageText.slice(0, 500),
  })
  await maybeContinueParentWorkflow(deps, payload, {
    output: {
      error: messageText,
      runId: context.run.id,
      taskId: context.task.id,
    },
    success: false,
    summary: messageText.slice(0, 500),
  })
  await setAgentStatus(deps.prisma, context.agent.id, 'error')
  await publishRunUpdated(deps.realtimeTransport, context, 'failed')
  await publishTaskUpdated(
    deps.realtimeTransport,
    buildScopes(context),
    context.task.id,
    'failed',
  )
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'error',
  })

  await deps.prisma.taskEvent.create({
    data: {
      eventType: 'run.failed',
      payload: {
        message: messageText,
      },
      taskId: context.task.id,
    },
  })
}
