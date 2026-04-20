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
import {
  executeWorkflowBuiltinTool,
  type WorkflowBuiltinToolRuntimeContext,
} from '../run/tools.js'

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const resolveBoundValue = (bindings: unknown, key: unknown): unknown => {
  if (typeof key !== 'string' || key.length === 0) {
    return undefined
  }
  const record = asObject(bindings)
  return record[key]
}

type WorkflowStepSnapshot = {
  input: unknown
  output: unknown
  status: string
}

type WorkflowBindingContext = {
  workflowBindings: unknown
  workflowConfig: unknown
  workflowInput: unknown
  stepSnapshots: Record<string, WorkflowStepSnapshot>
}

const TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g

const getPathValue = (value: unknown, path: string[]): unknown => {
  let current: unknown = value
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }

    if (typeof current !== 'object') {
      return undefined
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return current
}

const resolveWorkflowBindingReference = (
  expression: string,
  context: WorkflowBindingContext,
): unknown => {
  const parts = expression.split('.').filter((part) => part.length > 0)
  if (parts.length === 0) {
    return undefined
  }

  const root = parts[0]
  if (root === 'workflow') {
    const scope = parts[1]
    if (scope === 'run' && parts[2] === 'input') {
      return getPathValue(context.workflowInput, parts.slice(3))
    }
    if (scope === 'input') {
      return getPathValue(context.workflowInput, parts.slice(2))
    }
    if (scope === 'config') {
      return getPathValue(context.workflowConfig, parts.slice(2))
    }
    if (scope === 'bindings') {
      return getPathValue(context.workflowBindings, parts.slice(2))
    }
    return undefined
  }

  if (root === 'steps') {
    const stepKey = parts[1]
    const stepSnapshot = stepKey ? context.stepSnapshots[stepKey] : undefined
    if (!stepSnapshot) {
      return undefined
    }

    const scope = parts[2]
    if (scope === 'input') {
      return getPathValue(stepSnapshot.input, parts.slice(3))
    }
    if (scope === 'output') {
      return getPathValue(stepSnapshot.output, parts.slice(3))
    }
    if (scope === 'status') {
      return stepSnapshot.status
    }
  }

  return undefined
}

const stringifyWorkflowBindingValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

const stripWorkflowDesignerConfig = (
  value: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'workflowDesigner'),
  )

const resolveWorkflowTemplateString = (
  value: string,
  context: WorkflowBindingContext,
): unknown => {
  const exactMatch = value.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/)
  if (exactMatch?.[1]) {
    const resolved = resolveWorkflowBindingReference(exactMatch[1], context)
    if (resolved === undefined) {
      throw new Error(`WORKFLOW_BINDING_NOT_FOUND:${exactMatch[1]}`)
    }
    return resolved
  }

  return value.replace(TOKEN_PATTERN, (_match, expression: string) => {
    const resolved = resolveWorkflowBindingReference(expression, context)
    if (resolved === undefined) {
      throw new Error(`WORKFLOW_BINDING_NOT_FOUND:${expression}`)
    }
    return stringifyWorkflowBindingValue(resolved)
  })
}

export const resolveWorkflowStepInput = (
  value: unknown,
  context: WorkflowBindingContext,
): unknown => {
  if (typeof value === 'string') {
    return resolveWorkflowTemplateString(value, context)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveWorkflowStepInput(entry, context))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveWorkflowStepInput(entry, context),
      ]),
    )
  }
  return value
}

const buildWorkflowStepSnapshots = (
  stepRuns: Awaited<ReturnType<typeof listWorkflowStepRuns>>,
): Record<string, WorkflowStepSnapshot> =>
  Object.fromEntries(
    stepRuns.map((stepRun) => [
      stepRun.stepKey,
      {
        input: stepRun.input,
        output: stepRun.output,
        status: stepRun.status,
      },
    ]),
  )

const buildAgentTaskBody = (
  stepInput: Record<string, unknown>,
  workflowInput: unknown,
): string => {
  const publicStepInput = stripWorkflowDesignerConfig(stepInput)
  const prompt = typeof publicStepInput['prompt'] === 'string' ? publicStepInput['prompt'].trim() : ''
  if (prompt) {
    return prompt
  }

  return JSON.stringify(
    {
      step: publicStepInput,
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
    actorId: string
    actorType: 'agent' | 'service' | 'user'
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
        actorId: input.actorId,
        actorType: input.actorType,
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
      systemChannelType: null,
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
      agent: {
        agentKind: 'shared',
      },
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

    let resolvedStepInput: unknown
    try {
      resolvedStepInput = resolveWorkflowStepInput(stepDefinition.input ?? {}, {
        stepSnapshots: buildWorkflowStepSnapshots(stepRuns),
        workflowBindings: workflow.installation.resolvedBindings,
        workflowConfig: workflow.installation.config,
        workflowInput: workflow.run.input,
      })
    } catch (error) {
      await markWorkflowStepRunFinished(prisma, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary:
          error instanceof Error
            ? error.message
            : 'Workflow step input binding resolution failed.',
      })
      return
    }

    if (
      !resolvedStepInput ||
      typeof resolvedStepInput !== 'object' ||
      Array.isArray(resolvedStepInput)
    ) {
      await markWorkflowStepRunFinished(prisma, {
        workflowRunId,
        stepRunId: nextStep.id,
        success: false,
        summary: 'Workflow step input must resolve to an object.',
      })
      return
    }

    const stepInput = resolvedStepInput as Record<string, unknown>
    const runtimeStepType =
      stepDefinition.type === 'tool'
        ? 'tool_call'
        : stepDefinition.type === 'agent'
          ? 'agent_task'
          : stepDefinition.type

    if (runtimeStepType === 'trigger') {
      await markWorkflowStepRunFinished(prisma, {
        output: {
          skipped: true,
        },
        workflowRunId,
        stepRunId: nextStep.id,
        success: true,
        summary: 'Trigger node is visual-only at runtime.',
      })
      continue
    }

    if (runtimeStepType === 'tool_call') {
      const toolName = typeof stepInput['toolName'] === 'string' ? stepInput['toolName'] : ''
      if (!toolName) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary: 'Tool call step requires toolName.',
        })
        return
      }

      const toolArgs = Object.fromEntries(
        Object.entries(stripWorkflowDesignerConfig(stepInput)).filter(
          ([key]) => key !== 'toolName',
        ),
      )

      await markWorkflowStepRunStarted(prisma, {
        input: stepInput,
        output: {
          input: toolArgs,
          toolName,
        },
        stepRunId: nextStep.id,
      })

      try {
        const toolContext: WorkflowBuiltinToolRuntimeContext = {
          organizationId: workflow.run.organizationId,
          prisma,
          workflowInstallationId: workflow.installation.id,
          workflowRunId,
          workflowStepRunId: nextStep.id,
        }
        const toolResult = await executeWorkflowBuiltinTool(toolName, toolArgs, toolContext)

        const finishResult = await markWorkflowStepRunFinished(prisma, {
          output: {
            result: toolResult.output,
            toolName,
          },
          workflowRunId,
          stepRunId: nextStep.id,
          success: toolResult.success,
          summary: toolResult.summary,
        })

        if (!toolResult.success || finishResult.workflowRunCompleted || !finishResult.continueWorkflow) {
          return
        }
      } catch (error) {
        await markWorkflowStepRunFinished(prisma, {
          workflowRunId,
          stepRunId: nextStep.id,
          success: false,
          summary:
            error instanceof Error
              ? error.message
              : `Workflow tool call failed: ${toolName}`,
        })
        return
      }

      continue
    }

    if (runtimeStepType === 'agent_task') {
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
        actorId: workflow.run.startedByActorId,
        actorType: parseWorkflowStartedByActorType(workflow.run.startedByActorType),
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
        input: stepInput,
        workflowRunId,
        workflowStepRunId: nextStep.id,
        output: {
          mailboxMessageId: mailboxMessage.id,
          targetAgentId: toAgentId,
        },
      })
      return
    }

    if (runtimeStepType === 'environment_launch') {
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
          input: stepInput,
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

    await markWorkflowStepRunStarted(prisma, { input: stepInput, stepRunId: nextStep.id })
    await markWorkflowStepRunFinished(prisma, {
      workflowRunId,
      stepRunId: nextStep.id,
      success: false,
      summary: `Unsupported workflow step type: ${runtimeStepType}`,
    })
    return
  }
}
