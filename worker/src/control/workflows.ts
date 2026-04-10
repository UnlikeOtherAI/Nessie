import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../queue.js'
import {
  ensureWorkflowStepRuns,
  listWorkflowStepRuns,
  loadWorkflowGraph,
  markWorkflowRunFinished,
  markWorkflowRunStarted,
  markWorkflowStepRunFinished,
  markWorkflowStepRunQueued,
  markWorkflowStepRunStarted,
} from '../run/workflows.js'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const resolveBoundValue = (
  bindings: unknown,
  key: unknown,
): unknown => {
  if (typeof key !== 'string' || key.length === 0) {
    return undefined
  }
  const record = asObject(bindings)
  return record[key]
}

const buildAgentTaskBody = (stepInput: Record<string, unknown>, workflowInput: unknown): string => {
  const prompt = typeof stepInput['prompt'] === 'string' ? stepInput['prompt'].trim() : ''
  if (prompt) {
    return prompt
  }

  return JSON.stringify(
    {
      step: stepInput,
      workflowInput,
    },
    null,
    2,
  )
}

const parseWorkflowStartedByActorType = (
  value: string,
): 'agent' | 'service' | 'user' => {
  if (value === 'agent' || value === 'service' || value === 'user') {
    return value
  }

  throw new Error(`WORKFLOW_ACTOR_TYPE_INVALID:${value}`)
}

const buildWorkflowExecutionActorContext = (input: {
  channelId?: string | null
  organizationId: string
  projectId?: string | null
  stepRunId: string
  teamId?: string | null
  workflowRunId: string
  workflowStartedByActorId: string
  workflowStartedByActorType: string
}): AuthorizedActionContext => ({
  actor: {
    actorId: input.workflowStartedByActorId,
    actorType: parseWorkflowStartedByActorType(input.workflowStartedByActorType),
  },
  tenant: {
    organizationId: parseOrganizationId(input.organizationId),
    ...(input.projectId ? { projectId: parseProjectId(input.projectId) } : {}),
    ...(input.teamId ? { teamId: parseTeamId(input.teamId) } : {}),
    ...(input.channelId ? { channelId: parseChannelId(input.channelId) } : {}),
  },
  actionContext: {
    requestId: `workflow-environment:${input.stepRunId}`,
    correlationId: input.workflowRunId,
    ...(input.channelId ? { channelId: parseChannelId(input.channelId) } : {}),
    purpose: 'workflow.environment.allocate',
    sessionId: input.workflowRunId,
  },
})

const createWorkflowMailboxMessage = async (
  prisma: PrismaClient,
  input: {
    body: string
    channelId?: string | null
    fromAgentId?: string | null
    organizationId: string
    subject?: string
    threadId?: string
    toAgentId: string
    workflowRunId: string
    workflowStepRunId: string
  },
): Promise<{ id: string }> => {
  const correlationId = `workflow-step:${input.workflowStepRunId}`

  try {
    return await prisma.agentMailboxMessage.create({
      data: {
        organizationId: input.organizationId,
        workflowRunId: input.workflowRunId,
        workflowStepRunId: input.workflowStepRunId,
        fromAgentId: input.fromAgentId ?? undefined,
        toAgentId: input.toAgentId,
        channelId: input.channelId ?? undefined,
        threadId: input.threadId,
        subject: input.subject,
        body: input.body,
        correlationId,
      },
      select: { id: true },
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await prisma.agentMailboxMessage.findFirst({
        where: {
          organizationId: input.organizationId,
          toAgentId: input.toAgentId,
          correlationId,
        },
        select: { id: true },
      })
      if (existing) {
        return existing
      }
    }
    throw error
  }
}

const validateWorkflowAgentTaskTarget = async (
  prisma: PrismaClient,
  input: {
    channelId: string
    organizationId: string
    threadId?: string
    toAgentId: string
  },
): Promise<{ threadId?: string }> => {
  const channel = await prisma.channel.findFirst({
    where: {
      id: input.channelId,
      organizationId: input.organizationId,
    },
    select: { id: true },
  })
  if (!channel) {
    throw new Error('WORKFLOW_AGENT_TASK_CHANNEL_NOT_FOUND')
  }

  if (input.threadId) {
    const thread = await prisma.thread.findFirst({
      where: {
        id: input.threadId,
        channelId: input.channelId,
        channel: {
          organizationId: input.organizationId,
        },
      },
      select: { id: true },
    })
    if (!thread) {
      throw new Error('WORKFLOW_AGENT_TASK_THREAD_NOT_FOUND')
    }
  }

  const binding = await prisma.agentBinding.findFirst({
    where: {
      agentId: input.toAgentId,
      channelId: input.channelId,
      channel: {
        organizationId: input.organizationId,
      },
    },
    select: { id: true },
  })
  if (!binding) {
    throw new Error('WORKFLOW_AGENT_TASK_BINDING_NOT_FOUND')
  }

  return {
    threadId: input.threadId,
  }
}

const validateWorkflowEnvironmentLaunch = async (
  prisma: PrismaClient,
  input: {
    channelId?: string
    organizationId: string
    templateId: string
  },
): Promise<{
    template: {
      id: string
      mode: 'container' | 'function' | 'vm'
      provider: 'docker' | 'gcloud'
    }
  }> => {
  const template = await prisma.executionEnvironmentTemplate.findFirst({
    where: {
      id: input.templateId,
      organizationId: input.organizationId,
      enabled: true,
    },
    select: {
      id: true,
      mode: true,
      provider: true,
    },
  })
  if (!template) {
    throw new Error('WORKFLOW_ENVIRONMENT_TEMPLATE_NOT_FOUND')
  }

  if (input.channelId) {
    const channel = await prisma.channel.findFirst({
      where: {
        id: input.channelId,
        organizationId: input.organizationId,
      },
      select: { id: true },
    })
    if (!channel) {
      throw new Error('WORKFLOW_ENVIRONMENT_CHANNEL_NOT_FOUND')
    }
  }

  return { template }
}

export const executeWorkflowRun = async (
  prisma: PrismaClient,
  workflowRunId: string,
): Promise<void> => {
  const workflow = await loadWorkflowGraph(prisma, workflowRunId)
  if (!workflow) {
    return
  }
  if (workflow.run.status === 'completed' || workflow.run.status === 'failed' || workflow.run.status === 'cancelled') {
    return
  }

  await ensureWorkflowStepRuns(prisma, {
    workflowRunId,
    steps: workflow.graph.steps,
  })

  if (workflow.run.status === 'pending') {
    await markWorkflowRunStarted(prisma, workflowRunId)
  }

  while (true) {
    const stepRuns = await listWorkflowStepRuns(prisma, workflowRunId)
    const runningStep = stepRuns.find((step) => step.status === 'running')
    if (runningStep) {
      return
    }

    const nextStep = stepRuns.find((step) => step.status === 'pending')
    if (!nextStep) {
      await markWorkflowRunFinished(prisma, {
        workflowRunId,
        success: true,
        summary: 'Workflow run completed.',
      })
      return
    }

    const stepDefinition = workflow.graph.steps[nextStep.sequence]
    if (!stepDefinition) {
      await markWorkflowStepRunFinished(prisma, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary: 'Workflow step definition missing from template graph.',
      })
      return
    }

    const stepInput = stepDefinition.input ?? {}

    if (stepDefinition.type === 'agent_task') {
      const toAgentId = typeof stepInput['agentId'] === 'string' ? stepInput['agentId'] : undefined
      const channelId =
        typeof stepInput['channelId'] === 'string'
          ? stepInput['channelId']
          : workflow.installation.channelId
      const threadId = typeof stepInput['threadId'] === 'string' ? stepInput['threadId'] : undefined

      if (!toAgentId || !channelId) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Agent task step requires agentId and channelId.',
        })
        return
      }

      try {
        await validateWorkflowAgentTaskTarget(prisma, {
          organizationId: workflow.run.organizationId,
          toAgentId,
          channelId,
          threadId,
        })
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: error instanceof Error ? error.message : 'Invalid workflow agent task target.',
        })
        return
      }

      const mailboxMessage = await createWorkflowMailboxMessage(prisma, {
        organizationId: workflow.run.organizationId,
        workflowRunId,
        workflowStepRunId: nextStep.id,
        fromAgentId:
          workflow.run.startedByActorType === 'agent' ? workflow.run.startedByActorId : null,
        toAgentId,
        channelId,
        threadId,
        subject: typeof stepInput['subject'] === 'string' ? stepInput['subject'] : undefined,
        body: buildAgentTaskBody(stepInput, workflow.run.input),
      })

      await markWorkflowStepRunQueued(prisma, {
        workflowRunId,
        workflowStepRunId: nextStep.id,
        output: {
          mailboxMessageId: mailboxMessage.id,
          targetAgentId: toAgentId,
        },
      })
      return
    }

    if (stepDefinition.type === 'environment_launch') {
      const boundTemplateId = resolveBoundValue(
        workflow.installation.resolvedBindings,
        stepInput['templateBindingKey'],
      )
      const templateId =
        typeof stepInput['templateId'] === 'string'
          ? stepInput['templateId']
          : typeof boundTemplateId === 'string'
            ? boundTemplateId
            : undefined

      if (!templateId) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Environment launch step requires templateId or templateBindingKey.',
        })
        return
      }

      const resolvedChannelId =
        typeof stepInput['channelId'] === 'string'
          ? stepInput['channelId']
          : workflow.installation.channelId

      try {
        await validateWorkflowEnvironmentLaunch(prisma, {
          organizationId: workflow.run.organizationId,
          templateId,
          channelId: resolvedChannelId ?? undefined,
        })
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary:
            error instanceof Error
              ? error.message
              : 'Invalid workflow environment launch target.',
        })
        return
      }

      const actorContext = buildWorkflowExecutionActorContext({
        channelId: resolvedChannelId,
        organizationId: workflow.run.organizationId,
        projectId: workflow.installation.projectId,
        stepRunId: nextStep.id,
        teamId: workflow.installation.teamId,
        workflowRunId,
        workflowStartedByActorId: workflow.run.startedByActorId,
        workflowStartedByActorType: workflow.run.startedByActorType,
      })

      await prisma.$transaction(async (tx) => {
        const created = await tx.executionEnvironmentInstance.create({
          data: {
            templateId,
            organizationId: workflow.run.organizationId,
            projectId: workflow.installation.projectId,
            teamId: workflow.installation.teamId,
            channelId: resolvedChannelId,
            workflowRunId,
            workflowStepRunId: nextStep.id,
            launchedByActorType: workflow.run.startedByActorType,
            launchedByActorId: workflow.run.startedByActorId,
            launchConfig: stepInput as Prisma.InputJsonValue,
          },
          select: { id: true },
        })

        await markWorkflowStepRunQueued(tx, {
          workflowRunId,
          workflowStepRunId: nextStep.id,
          output: {
            environmentInstanceId: created.id,
            status: 'pending',
          },
        })

        await enqueueQueueJob(tx, {
          idempotencyKey: `execution-environment:${created.id}`,
          payload: {
            actorContext,
            instanceId: created.id,
          },
          topic: 'execution.environment.allocate',
        })
      })
      return
    }

    await markWorkflowStepRunStarted(prisma, { stepRunId: nextStep.id })
    await markWorkflowStepRunFinished(prisma, {
      workflowRunId,
      stepRunId: nextStep.id,
      success: false,
      summary: `Unsupported workflow step type: ${stepDefinition.type}`,
    })
    return
  }
}
