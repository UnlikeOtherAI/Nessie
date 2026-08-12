import { type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '../../queue.js'
import { loadWorkflowGraph } from '../../run/workflows.js'
import { finishWorkflowStepRun } from '../../run/workflow-step-finish.js'
import { asObject } from './stored-json.js'
import type { WorkflowInstanceState, WorkflowLinkedInstance } from './types.js'

const buildWorkflowActorContext = (instance: WorkflowLinkedInstance) => ({
  actor: {
    actorId: instance.launchedByActorId,
    actorType: instance.launchedByActorType as 'agent' | 'service' | 'user',
  },
  tenant: {
    organizationId: instance.organizationId,
    ...(instance.projectId ? { projectId: instance.projectId } : {}),
    ...(instance.teamId ? { teamId: instance.teamId } : {}),
    ...(instance.channelId ? { channelId: instance.channelId } : {}),
  },
  actionContext: {
    requestId: `execution-environment:${instance.id}`,
    correlationId: instance.workflowStepRunId ?? instance.workflowRunId ?? instance.id,
    ...(instance.channelId ? { channelId: instance.channelId } : {}),
    purpose: 'workflow.environment.allocate',
    sessionId: instance.workflowRunId ?? instance.id,
  },
})

export const maybeContinueWorkflowForInstance = async (
  prisma: PrismaClient,
  input: {
    instance: WorkflowLinkedInstance
    output?: Record<string, unknown>
    success: boolean
    summary?: string
  },
): Promise<void> => {
  if (!input.instance.workflowRunId || !input.instance.workflowStepRunId) {
    return
  }

  const workflow = await loadWorkflowGraph(prisma, input.instance.workflowRunId)
  if (!workflow) {
    return
  }

  // Finish through the emitting seam so an asynchronous environment step
  // that terminalizes the run fires workflow.run.completed / .failed.
  // `applied: false` (concurrent terminalization) also reports
  // continueWorkflow: false, so the continuation enqueue stays skipped.
  const result = await finishWorkflowStepRun(prisma, workflow, {
    output: input.output,
    stepRunId: input.instance.workflowStepRunId,
    success: input.success,
    summary: input.summary,
    workflowRunId: input.instance.workflowRunId,
  })
  if (!result.continueWorkflow) {
    return
  }

  await enqueueQueueJob(prisma, {
    idempotencyKey: `workflow-run:continue:${input.instance.workflowRunId}:${input.instance.workflowStepRunId}`,
    payload: {
      actorContext: buildWorkflowActorContext(input.instance),
      workflowRunId: input.instance.workflowRunId,
    },
    topic: 'workflow.run.execute',
  })
}

export const buildWorkflowInstanceOutput = (input: {
  errorMessage?: string | null
  instanceId: string
  metadata?: unknown
  providerInstanceRef?: string | null
  status: string
}): Record<string, unknown> => ({
  environmentInstanceId: input.instanceId,
  status: input.status,
  ...(input.providerInstanceRef ? { providerInstanceRef: input.providerInstanceRef } : {}),
  ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  ...asObject(input.metadata),
})

export const loadWorkflowInstanceState = async (
  prisma: PrismaClient,
  instanceId: string,
): Promise<WorkflowInstanceState | null> =>
  prisma.executionEnvironmentInstance.findUnique({
    where: { id: instanceId },
    select: {
      agentId: true,
      channelId: true,
      errorMessage: true,
      id: true,
      launchedByActorId: true,
      launchedByActorType: true,
      metadata: true,
      organizationId: true,
      projectId: true,
      providerInstanceRef: true,
      runId: true,
      status: true,
      teamId: true,
      workflowRunId: true,
      workflowStepRunId: true,
    },
  })
