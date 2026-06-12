import { type PrismaClient } from '@prisma/client'
import { enqueueQueueJob } from '../../queue.js'
import { markWorkflowStepRunFinished } from '../../run/workflows.js'
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

  const result = await markWorkflowStepRunFinished(prisma, {
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
