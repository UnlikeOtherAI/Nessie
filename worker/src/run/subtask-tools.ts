import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
} from '@nessie/schemas'
import { enqueueRunExecution } from '../queue.js'
import { appendDelegationStep } from './plans.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

const normalizeSubtaskRole = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === 'researcher' || normalized === 'builder' || normalized === 'reviewer') {
    return normalized
  }

  return 'assistant'
}

const buildSubtaskSystemPrompt = (input: {
  parentName: string
  parentSystemPrompt: string | null
  role: string
}): string => {
  const roleLabel = input.role === 'assistant' ? 'specialist' : input.role
  const lines = [
    `You are a delegated ${roleLabel} sub-agent working for ${input.parentName}.`,
    'Focus only on the assigned sub-task, use the available tools when needed, and report concrete results back in this thread.',
    'Do not ask the user to restate context already present in the thread, and do not spawn further subtasks.',
  ]

  const parentPrompt = input.parentSystemPrompt?.trim()
  if (parentPrompt) {
    lines.push('', 'Parent agent instructions:', parentPrompt)
  }

  return lines.join('\n')
}

export const runSpawnSubtaskTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    role?: unknown
    task?: unknown
  },
): Promise<ToolExecutionResult> => {
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (!task) {
    throw new Error('task is required.')
  }

  const role = normalizeSubtaskRole(input.role)
  const parentAgent = await context.prisma.agent.findUnique({
    where: { id: context.agentId },
    select: {
      id: true,
      model: true,
      name: true,
      provider: true,
      systemPrompt: true,
      toolPolicy: true,
    },
  })
  if (!parentAgent) {
    throw new Error('Parent agent not found.')
  }

  const plan = await context.prisma.plan.findFirst({
    where: { runId: context.run.id },
    select: { id: true },
  })

  const child = await context.prisma.$transaction(async (tx) => {
    const childAgent = await tx.agent.create({
      data: {
        agentKind: 'shared',
        delegationMode: 'none',
        model: parentAgent.model,
        name: `${parentAgent.name} ${role} ${randomUUID().slice(0, 8)}`,
        organizationId: context.channel.organizationId,
        parentAgentId: parentAgent.id,
        provider: parentAgent.provider,
        role,
        surfacePolicy: 'shared',
        systemManaged: false,
        systemPrompt: buildSubtaskSystemPrompt({
          parentName: parentAgent.name,
          parentSystemPrompt: parentAgent.systemPrompt,
          role,
        }),
        toolPolicy: (parentAgent.toolPolicy ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true, name: true },
    })

    const planStep = plan
      ? await appendDelegationStep(tx, {
        assignedAgentId: childAgent.id,
        planId: plan.id,
        payload: { role, task },
        title: `${role}: ${task}`,
      })
      : null

    const run = await tx.run.create({
      data: {
        agentId: childAgent.id,
        status: 'pending',
        threadId: context.run.threadId,
      },
      select: { id: true, threadId: true },
    })

    const childTask = await tx.task.create({
      data: {
        agentId: childAgent.id,
        organizationId: context.channel.organizationId,
        purpose: task.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    await enqueueRunExecution(
      tx,
      {
        actorContext: withActionContext(context.actorContext, {
          agentId: parseAgentId(childAgent.id),
          channelId: parseChannelId(context.channel.id),
          taskId: parseTaskId(childTask.id),
          threadId: parseThreadId(context.run.threadId),
        }),
        agentId: parseAgentId(childAgent.id),
        messageId: context.run.messageId,
        parentPlanId: plan?.id,
        parentPlanStepId: planStep?.stepId,
        promptOverride: task,
        runId: parseRunId(run.id),
        taskId: parseTaskId(childTask.id),
        threadId: parseThreadId(run.threadId),
      },
      `subtask:${context.run.id}:${childAgent.id}`,
    )

    return {
      agentId: childAgent.id,
      agentName: childAgent.name,
      planStepId: planStep?.stepId ?? null,
      runId: run.id,
      taskId: childTask.id,
    }
  })

  await context.realtimeTransport.publishWs(
    [{ kind: 'channel', channelId: parseChannelId(context.channel.id) }],
    {
      data: {
        childId: parseAgentId(child.agentId),
        parentId: parseAgentId(context.agentId),
        taskId: parseTaskId(child.taskId),
        threadId: parseThreadId(context.run.threadId),
      },
      event: 'agent.spawned',
    },
  )

  return {
    inputSummary: task.slice(0, 200),
    outputPreview: [
      `Spawned ${role} sub-agent.`,
      `agentId=${child.agentId} | name="${child.agentName}"`,
      `runId=${child.runId} | taskId=${child.taskId}`,
      child.planStepId ? `planStepId=${child.planStepId}` : 'planStepId=none',
    ].join('\n'),
    toolName: 'spawn_subtask',
  }
}
