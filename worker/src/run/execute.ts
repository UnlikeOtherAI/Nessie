import type { PrismaClient } from '@prisma/client'
import type {
  ModelClient,
  ModelMessage,
  PgRealtimeTransport,
  QueueProvider,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type RunExecuteJobPayload,
  type RunStatus,
  type TaskStatus,
  type WsScope,
} from '@nessie/schemas'
import {
  runDocumentReadTool,
  runWebFetchTool,
  runWebSearchTool,
  shouldUseDocumentRead,
  shouldUseWebFetch,
  shouldUseWebSearch,
} from './tools.js'

type ExecutionDependencies = {
  modelClient: ModelClient
  prisma: PrismaClient
  queueProvider: QueueProvider
  realtimeTransport: PgRealtimeTransport
}

type RunContext = {
  agent: {
    id: string
    name: string
    parentAgentId: string | null
    systemPrompt: string | null
  }
  channel: {
    id: string
    organizationId: string
  }
  run: {
    id: string
    threadId: string
  }
  task: {
    id: string
  }
}

type StoredConversationMessage = {
  content: string
  role: 'assistant' | 'system' | 'user'
}

const MAX_TOOL_CONTEXT_LENGTH = 400

const buildScopes = (context: RunContext): WsScope[] => [
  {
    kind: 'organization',
    organizationId: parseOrganizationId(context.channel.organizationId),
  },
  {
    kind: 'channel',
    channelId: parseChannelId(context.channel.id),
  },
  {
    kind: 'agent',
    agentId: parseAgentId(context.agent.id),
  },
]

const publishRunUpdated = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  status: RunStatus,
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
      status,
    },
    event: 'run.updated',
  })
}

const publishAgentStatus = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  input: {
    status: 'idle' | 'thinking' | 'executing' | 'error'
    currentRunId?: string
    currentToolName?: string
    currentToolStartedAt?: string
  },
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      status: input.status,
      since: new Date().toISOString(),
      currentRunId: input.currentRunId ? parseRunId(input.currentRunId) : undefined,
      currentToolName: input.currentToolName,
      currentToolStartedAt: input.currentToolStartedAt,
    },
    event: 'agent.status',
  })
}

const updateTaskStatus = async (
  prisma: PrismaClient,
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  await prisma.task.update({
    where: { id: taskId },
    data: { status },
  })
}

const updateRunStatus = async (
  prisma: PrismaClient,
  runId: string,
  status: RunStatus,
): Promise<void> => {
  await prisma.run.update({
    where: { id: runId },
    data: {
      finishedAt: status === 'completed' || status === 'failed' ? new Date() : null,
      startedAt: status === 'running' ? new Date() : undefined,
      status,
    },
  })
}

const setAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
  status: 'idle' | 'thinking' | 'executing' | 'error',
): Promise<void> => {
  await prisma.agent.update({
    where: { id: agentId },
    data: { status },
  })
}

const loadRunContext = async (
  prisma: PrismaClient,
  payload: RunExecuteJobPayload,
): Promise<RunContext | null> => {
  const run = await prisma.run.findUnique({
    where: { id: payload.runId },
    include: {
      agent: {
        select: {
          id: true,
          name: true,
          parentAgentId: true,
          systemPrompt: true,
        },
      },
      thread: {
        select: {
          id: true,
          channel: {
            select: {
              id: true,
              organizationId: true,
            },
          },
        },
      },
      tasks: {
        where: { id: payload.taskId },
        select: { id: true },
        take: 1,
      },
    },
  })

  const task = run?.tasks[0]
  if (!run || !task) {
    return null
  }

  return {
    agent: run.agent,
    channel: run.thread.channel,
    run: {
      id: run.id,
      threadId: run.thread.id,
    },
    task,
  }
}

const recordToolEnd = async (
  deps: ExecutionDependencies,
  context: RunContext,
  input: {
    durationMs: number
    inputSummary: string
    outputPreview: string
    startedAt: Date
    success: boolean
    toolName: string
  },
): Promise<void> => {
  const endedAt = new Date()

  await deps.prisma.toolCall.create({
    data: {
      agentId: context.agent.id,
      durationMs: input.durationMs,
      endedAt,
      inputSummary: input.inputSummary,
      outputPreview: input.outputPreview,
      runId: context.run.id,
      startedAt: input.startedAt,
      success: input.success,
      toolName: input.toolName,
    },
  })

  await deps.realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      durationMs: input.durationMs,
      runId: parseRunId(context.run.id),
      success: input.success,
      toolName: input.toolName,
    },
    event: 'agent.tool.end',
  })
}

const resetAgentToThinking = async (
  deps: ExecutionDependencies,
  context: RunContext,
): Promise<void> => {
  await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    status: 'thinking',
  })
}

const executeSafeTool = async (
  deps: ExecutionDependencies,
  context: RunContext,
  toolName: 'document_read' | 'web_fetch' | 'web_search',
  prompt: string,
): Promise<string> => {
  const startedAt = new Date()

  await setAgentStatus(deps.prisma, context.agent.id, 'executing')
  await publishAgentStatus(deps.realtimeTransport, context, {
    currentRunId: context.run.id,
    currentToolName: toolName,
    currentToolStartedAt: startedAt.toISOString(),
    status: 'executing',
  })

  await deps.realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      inputSummary: prompt.slice(0, 200),
      runId: parseRunId(context.run.id),
      toolName,
    },
    event: 'agent.tool.start',
  })

  try {
    const result =
      toolName === 'document_read'
        ? await runDocumentReadTool(prompt)
        : toolName === 'web_fetch'
          ? await runWebFetchTool(prompt)
          : await runWebSearchTool(prompt)
    const durationMs = Math.max(0, Date.now() - startedAt.getTime())

    await recordToolEnd(deps, context, {
      durationMs,
      inputSummary: result.inputSummary,
      outputPreview: result.outputPreview,
      startedAt,
      success: true,
      toolName: result.toolName,
    })

    await resetAgentToThinking(deps, context)
    return result.outputPreview
  } catch (error) {
    const outputPreview =
      error instanceof Error ? error.message : 'Tool execution failed unexpectedly'
    const durationMs = Math.max(0, Date.now() - startedAt.getTime())

    await recordToolEnd(deps, context, {
      durationMs,
      inputSummary: prompt.slice(0, 200),
      outputPreview,
      startedAt,
      success: false,
      toolName,
    })

    await resetAgentToThinking(deps, context)
    return outputPreview
  }
}

const maybeSpawnChildAgent = async (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
  prompt: string,
): Promise<string | null> => {
  if (context.agent.parentAgentId || !/\b(spawn|delegate|sub-agent|subagent)\b/i.test(prompt)) {
    return null
  }

  const child = await deps.prisma.agent.create({
    data: {
      bindings: {
        create: {
          channelId: context.channel.id,
        },
      },
      name: `${context.agent.name} Research`,
      parentAgentId: context.agent.id,
      role: 'assistant',
      status: 'idle',
      systemPrompt: 'Handle a delegated sub-task and report back succinctly.',
    },
  })

  const childRun = await deps.prisma.run.create({
    data: {
      agentId: child.id,
      status: 'pending',
      threadId: context.run.threadId,
    },
  })

  const childTask = await deps.prisma.task.create({
    data: {
      agentId: child.id,
      parentTaskId: context.task.id,
      purpose: `Delegated from ${context.agent.name}: ${prompt.slice(0, 160)}`,
      runId: childRun.id,
      status: 'inbox',
    },
  })

  await deps.realtimeTransport.publishWs(buildScopes(context), {
    data: {
      childId: parseAgentId(child.id),
      parentId: parseAgentId(context.agent.id),
      taskId: parseTaskId(childTask.id),
    },
    event: 'agent.spawned',
  })

  await deps.queueProvider.enqueue('run.execute', {
    actorContext: {
      ...payload.actorContext,
      actionContext: {
        ...payload.actorContext.actionContext,
        agentId: parseAgentId(child.id),
        taskId: parseTaskId(childTask.id),
      },
    },
    agentId: parseAgentId(child.id),
    messageId: payload.messageId,
    runId: parseRunId(childRun.id),
    taskId: parseTaskId(childTask.id),
    threadId: parseThreadId(childRun.threadId),
  })

  return child.name
}

const buildModelPrompt = (
  conversation: StoredConversationMessage[],
  context: RunContext,
  prompt: string,
  toolOutputs: string[],
  childAgentName: string | null,
): ModelMessage[] => {
  const systemParts = [
    `You are ${context.agent.name}.`,
    context.agent.systemPrompt?.trim() ?? '',
    'Respond directly to the request using the available tool results when they are relevant.',
    'Keep the answer concise and concrete.',
  ].filter((part) => part.length > 0)

  const promptParts = [prompt.trim()]

  if (toolOutputs.length > 0) {
    const truncatedToolOutputs = toolOutputs.map((output) =>
      output.length <= MAX_TOOL_CONTEXT_LENGTH
        ? output
        : `${output.slice(0, MAX_TOOL_CONTEXT_LENGTH - 1)}…`,
    )

    promptParts.push(`Tool results:\n${truncatedToolOutputs.join('\n\n')}`)
  }

  if (childAgentName) {
    promptParts.push(`A delegated sub-agent named ${childAgentName} was spawned.`)
  }

  const messages: ModelMessage[] = [{ content: systemParts.join('\n\n'), role: 'system' }]

  if (conversation.length > 0) {
    messages.push(...conversation)
  }

  if (toolOutputs.length > 0 || childAgentName) {
    messages.push({
      content: promptParts.slice(1).join('\n\n'),
      role: 'system',
    })
  }

  if (conversation.length === 0 || conversation.at(-1)?.role !== 'user') {
    messages.push({ content: prompt.trim(), role: 'user' })
  }

  return messages
}

const loadConversation = async (
  prisma: PrismaClient,
  threadId: string,
): Promise<StoredConversationMessage[]> => {
  const messages = await prisma.message.findMany({
    where: { threadId },
    orderBy: { createdAt: 'desc' },
    select: {
      content: true,
      role: true,
    },
    take: 20,
  })

  return messages.reverse().map((message) => ({
    content: message.content,
    role: message.role,
  }))
}

export const executeRunJob = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
): Promise<void> => {
  const context = await loadRunContext(deps.prisma, payload)
  if (!context) {
    return
  }

  const message = await deps.prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { content: true },
  })

  if (!message) {
    return
  }

  try {
    await updateRunStatus(deps.prisma, context.run.id, 'running')
    await updateTaskStatus(deps.prisma, context.task.id, 'in_progress')
    await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
    await publishRunUpdated(deps.realtimeTransport, context, 'running')
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'thinking',
    })

    const toolOutputs: string[] = []

    if (shouldUseDocumentRead(message.content)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'document_read', message.content))
    }

    if (shouldUseWebFetch(message.content)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'web_fetch', message.content))
    }

    if (shouldUseWebSearch(message.content)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'web_search', message.content))
    }

    const childAgentName = await maybeSpawnChildAgent(deps, context, payload, message.content)
    const conversation = await loadConversation(deps.prisma, context.run.threadId)
    const modelMessages = buildModelPrompt(
      conversation,
      context,
      message.content,
      toolOutputs,
      childAgentName,
    )

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })

    let responseText = ''
    for await (const chunk of deps.modelClient.stream(modelMessages)) {
      responseText += chunk
      await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
        content: chunk,
        runId: parseRunId(context.run.id),
      })
    }

    if (!responseText.trim()) {
      throw new Error('Model stream produced no content')
    }

    const assistantMessage = await deps.prisma.message.create({
      data: {
        agentId: context.agent.id,
        content: responseText,
        role: 'assistant',
        threadId: context.run.threadId,
      },
    })

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.done', {
      messageId: assistantMessage.id,
      runId: parseRunId(context.run.id),
    })

    await deps.realtimeTransport.publishWs(buildScopes(context), {
      data: {
        agentId: parseAgentId(context.agent.id),
        contentPreview: responseText.slice(0, 200),
        messageId: assistantMessage.id,
        role: 'assistant',
        threadId: parseThreadId(context.run.threadId),
      },
      event: 'message.new',
    })

    await updateRunStatus(deps.prisma, context.run.id, 'completed')
    await updateTaskStatus(deps.prisma, context.task.id, 'done')
    await setAgentStatus(deps.prisma, context.agent.id, 'idle')
    await publishRunUpdated(deps.realtimeTransport, context, 'completed')
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'idle',
    })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Run execution failed unexpectedly'

    await updateRunStatus(deps.prisma, context.run.id, 'failed')
    await updateTaskStatus(deps.prisma, context.task.id, 'failed')
    await setAgentStatus(deps.prisma, context.agent.id, 'error')
    await publishRunUpdated(deps.realtimeTransport, context, 'failed')
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

    throw error
  }
}
