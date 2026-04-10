import type { PrismaClient } from '@prisma/client'
import {
  markRecallsInjected,
  markRecallsReferenced,
  searchAndLogThoughts,
  type SearchExecutionConfig,
  type SearchResult,
} from '@nessie/memory'
import type {
  ModelClient,
  ModelMessage,
  PgRealtimeTransport,
  QueueProvider,
} from '@nessie/runtime'
import { BUILTIN_TOOL_DEFINITIONS, BUILTIN_TOOL_IDS } from '@nessie/runtime'
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
import {
  appendDelegationStep,
  ensureRunPlanContext,
  markRunPlanFinished,
  markRunPlanStarted,
} from './plans.js'

type ExecutionDependencies = {
  modelClient: ModelClient
  prisma: PrismaClient
  queueProvider: QueueProvider
  realtimeTransport: PgRealtimeTransport
  searchConfig: SearchExecutionConfig
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

type RunPlanContext = {
  planId: string
  rootStepId: string
}

type StoredConversationMessage = {
  content: string
  role: 'assistant' | 'system' | 'user'
}

const MAX_TOOL_CONTEXT_LENGTH = 400
const MAX_MEMORY_RESULTS = 5
const MAX_MEMORY_CONTEXT_LENGTH = 220
const MIN_REFERENCE_TOKENS = 5
const BUILTIN_TOOL_SCOPE_KEY = 'builtin'

type RetrievedMemory = Pick<SearchResult, 'content' | 'recallId'>

const buildScopes = (context: RunContext): WsScope[] => [
  ...buildScopesForAgent(context.channel, context.agent.id),
]

const loadAllowedToolIds = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<Set<string>> => {
  await Promise.all(
    BUILTIN_TOOL_DEFINITIONS.map((tool) =>
      prisma.toolRegistryEntry.upsert({
        where: {
          scopeKey_toolId: {
            scopeKey: BUILTIN_TOOL_SCOPE_KEY,
            toolId: tool.id,
          },
        },
        create: {
          builtin: true,
          description: tool.description,
          enabled: true,
          handlerKind: 'builtin',
          label: tool.label,
          scopeKey: BUILTIN_TOOL_SCOPE_KEY,
          safe: tool.safe,
          toolId: tool.id,
        },
        update: {
          builtin: true,
          description: tool.description,
          handlerKind: 'builtin',
          label: tool.label,
          scopeKey: BUILTIN_TOOL_SCOPE_KEY,
          safe: tool.safe,
        },
      }),
    ),
  )

  const enabledRegistryEntries = await prisma.toolRegistryEntry.findMany({
    where: {
      builtin: true,
      enabled: true,
      OR: [{ organizationId: null }, { organizationId: context.channel.organizationId }],
    },
    select: { toolId: true },
  })

  const enabledToolIds = new Set(
    enabledRegistryEntries
      .map((entry) => entry.toolId)
      .filter((toolId) => BUILTIN_TOOL_IDS.has(toolId as 'document_read' | 'web_fetch' | 'web_search')),
  )

  const [runScopedSessions, threadScopedSessions, agentScopedSessions] = await Promise.all([
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        runId: context.run.id,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        threadId: context.run.threadId,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
    prisma.temporaryContextSession.findMany({
      where: {
        organizationId: context.channel.organizationId,
        droppedAt: null,
        agentId: context.agent.id,
      },
      select: { toolIds: true },
      orderBy: [{ createdAt: 'desc' }],
    }),
  ])

  const activeSessions =
    runScopedSessions.length > 0
      ? runScopedSessions
      : threadScopedSessions.length > 0
        ? threadScopedSessions
        : agentScopedSessions

  const sessionToolIds = new Set<string>()
  for (const session of activeSessions) {
    if (!Array.isArray(session.toolIds)) {
      continue
    }
    for (const value of session.toolIds) {
      if (typeof value === 'string') {
        sessionToolIds.add(value)
      }
    }
  }

  if (sessionToolIds.size === 0) {
    return enabledToolIds
  }

  return new Set([...enabledToolIds].filter((toolId) => sessionToolIds.has(toolId)))
}

const truncateForContext = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`

const normalizeForReferenceMatch = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const buildReferencePhrases = (content: string): string[] => {
  const normalizedContent = normalizeForReferenceMatch(content)
  if (!normalizedContent) {
    return []
  }

  const phrases = new Set<string>()
  const sentenceCandidates = content
    .split(/[\n.!?;]+/)
    .map((part) => normalizeForReferenceMatch(part))
    .filter((part) => part.length >= 20)

  for (const phrase of sentenceCandidates.slice(0, 6)) {
    phrases.add(phrase)
  }

  const tokens = normalizedContent.split(' ').filter(Boolean)
  if (tokens.length < MIN_REFERENCE_TOKENS) {
    phrases.add(normalizedContent)
    return [...phrases]
  }

  const maxWindows = Math.min(tokens.length - MIN_REFERENCE_TOKENS + 1, 8)
  for (let index = 0; index < maxWindows; index += 1) {
    phrases.add(tokens.slice(index, index + MIN_REFERENCE_TOKENS).join(' '))
  }

  return [...phrases]
}

const isMemoryReferenced = (
  responseText: string,
  memoryContent: string,
): boolean => {
  const normalizedResponse = normalizeForReferenceMatch(responseText)
  if (!normalizedResponse) {
    return false
  }

  return buildReferencePhrases(memoryContent).some(
    (phrase) => phrase.length > 0 && normalizedResponse.includes(phrase),
  )
}

export const buildMemoryContext = (memories: RetrievedMemory[]): string | null => {
  if (memories.length === 0) {
    return null
  }

  const lines = memories.map(
    (memory, index) =>
      `${index + 1}. ${truncateForContext(memory.content.trim(), MAX_MEMORY_CONTEXT_LENGTH)}`,
  )

  return ['Relevant long-term memories:', ...lines].join('\n')
}

export const detectReferencedRecallIds = (
  responseText: string,
  memories: RetrievedMemory[],
): string[] =>
  memories.flatMap((memory) =>
    memory.recallId && isMemoryReferenced(responseText, memory.content)
      ? [memory.recallId]
      : [],
  )

const buildScopesForAgent = (
  channel: RunContext['channel'],
  agentId: string,
): WsScope[] => [
  {
    kind: 'organization',
    organizationId: parseOrganizationId(channel.organizationId),
  },
  {
    kind: 'channel',
    channelId: parseChannelId(channel.id),
  },
  {
    kind: 'agent',
    agentId: parseAgentId(agentId),
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

const publishMessageCreated = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  input: {
    content: string
    messageId: string
    role: 'assistant' | 'system' | 'user'
  },
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      contentPreview: input.content.slice(0, 200),
      messageId: input.messageId,
      role: input.role,
      threadId: parseThreadId(context.run.threadId),
    },
    event: 'message.new',
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

const publishTaskUpdated = async (
  realtimeTransport: PgRealtimeTransport,
  scopes: WsScope[],
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  await realtimeTransport.publishWs(scopes, {
    data: {
      taskId: parseTaskId(taskId),
      status,
    },
    event: 'task.updated',
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

const deriveDelegatedTask = (prompt: string): string => {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim()
  const delegationPatterns = [
    /\b(?:spawn|delegate)(?:\s+a)?(?:\s+sub-agent|\s+subagent)?\s+(?:to|for)\s+(.+?)(?:[.?!]|$)/i,
    /\b(?:spawn|delegate)(?:\s+a)?(?:\s+sub-agent|\s+subagent)?\b\s+(.+?)(?:[.?!]|$)/i,
  ]

  for (const pattern of delegationPatterns) {
    const match = normalizedPrompt.match(pattern)
    const task = match?.[1]?.replace(/^(and|then)\s+/i, '').trim()
    if (task) {
      return task
    }
  }

  return 'Summarize the parent request succinctly.'
}

const maybeSpawnChildAgent = async (
  deps: ExecutionDependencies,
  context: RunContext,
  prompt: string,
  planContext: RunPlanContext,
): Promise<string | null> => {
  if (context.agent.parentAgentId || !/\b(spawn|delegate|sub-agent|subagent)\b/i.test(prompt)) {
    return null
  }

  const delegatedTask = deriveDelegatedTask(prompt)

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

  const delegationStep = await appendDelegationStep(deps.prisma, {
    assignedAgentId: child.id,
    payload: {
      delegatedTask,
      parentAgentId: context.agent.id,
      parentRunId: context.run.id,
      parentTaskId: context.task.id,
    },
    planId: planContext.planId,
    title: `Delegate to ${child.name}: ${delegatedTask}`,
  })

  await deps.prisma.agentMailboxMessage.create({
    data: {
      body: [
        `Delegated sub-task from ${context.agent.name}.`,
        `Task: ${delegatedTask}`,
        `Parent request context: ${prompt.trim()}`,
        'Complete only the delegated task and report back succinctly.',
      ].join('\n\n'),
      channelId: context.channel.id,
      correlationId: `spawn:${context.run.id}:${child.id}`,
      fromAgentId: context.agent.id,
      organizationId: context.channel.organizationId,
      planId: planContext.planId,
      planStepId: delegationStep.stepId,
      subject: `Delegated task for ${child.name}`,
      threadId: context.run.threadId,
      toAgentId: child.id,
    },
  })

  return child.name
}

const retrieveRelevantMemories = async (
  deps: ExecutionDependencies,
  context: RunContext,
  payload: RunExecuteJobPayload,
  prompt: string,
): Promise<SearchResult[]> => {
  try {
    return await searchAndLogThoughts(
      {
        channelId: context.channel.id,
        includeReasoning: false,
        limit: MAX_MEMORY_RESULTS,
        mode: 'hybrid',
        organizationId: context.channel.organizationId,
        query: prompt,
        sessionId: payload.actorContext.actionContext.sessionId,
        userId: payload.actorContext.actor.actorId,
      },
      deps.searchConfig,
    )
  } catch (error) {
    console.warn(
      '[worker] Memory search failed, continuing without memories:',
      error instanceof Error ? error.message : error,
    )
    return []
  }
}

const buildModelPrompt = (
  conversation: StoredConversationMessage[],
  context: RunContext,
  prompt: string,
  toolOutputs: string[],
  childAgentName: string | null,
  memoryContext: string | null,
): ModelMessage[] => {
  const systemParts = [
    `You are ${context.agent.name}.`,
    context.agent.systemPrompt?.trim() ?? '',
    'Respond directly to the request using the available tool results when they are relevant.',
    'Use relevant memory context when it helps, but prefer the latest explicit user instructions on conflict.',
    'The required safe tools have already been executed.',
    'Do not emit tool-call markup or request more tool execution.',
    'Return plain text only.',
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

  if (toolOutputs.length > 0 || childAgentName) {
    messages.push({
      content: promptParts.slice(1).join('\n\n'),
      role: 'system',
    })
  }

  if (memoryContext) {
    messages.push({
      content: memoryContext,
      role: 'system',
    })
  }

  if (conversation.length > 0) {
    messages.push(...conversation)
  }

  const lastConversationMessage = conversation.at(-1)
  const shouldAppendPrompt =
    !lastConversationMessage ||
    lastConversationMessage.role !== 'user' ||
    lastConversationMessage.content.trim() !== prompt.trim()

  if (shouldAppendPrompt) {
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
  // Idempotency guard: skip if this run is already completed or failed
  const existingRun = await deps.prisma.run.findUnique({
    where: { id: payload.runId },
    select: { status: true, finishedAt: true },
  })
  if (
    existingRun &&
    (existingRun.status === 'completed' ||
      existingRun.status === 'failed' ||
      existingRun.status === 'cancelled')
  ) {
    console.log(`[worker] Skipping already-${existingRun.status} run ${payload.runId}`)
    return
  }

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

  const prompt = payload.promptOverride?.trim() || message.content
  let streamStarted = false
  let planContext: RunPlanContext | null = null

  try {
    planContext = await ensureRunPlanContext(deps.prisma, {
      agentId: context.agent.id,
      channelId: context.channel.id,
      createdByActorId: payload.actorContext.actor.actorId,
      createdByActorType: payload.actorContext.actor.actorType,
      goal: prompt,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

    await updateRunStatus(deps.prisma, context.run.id, 'running')
    await updateTaskStatus(deps.prisma, context.task.id, 'in_progress')
    await markRunPlanStarted(deps.prisma, planContext)
    await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
    await publishRunUpdated(deps.realtimeTransport, context, 'running')
    await publishTaskUpdated(
      deps.realtimeTransport,
      buildScopes(context),
      context.task.id,
      'in_progress',
    )
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'thinking',
    })

    const allowedToolIds = await loadAllowedToolIds(deps.prisma, context)
    const toolOutputs: string[] = []

    if (allowedToolIds.has('document_read') && shouldUseDocumentRead(prompt)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'document_read', prompt))
    }

    if (allowedToolIds.has('web_fetch') && shouldUseWebFetch(prompt)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'web_fetch', prompt))
    }

    if (allowedToolIds.has('web_search') && shouldUseWebSearch(prompt)) {
      toolOutputs.push(await executeSafeTool(deps, context, 'web_search', prompt))
    }

    const childAgentName = await maybeSpawnChildAgent(
      deps,
      context,
      prompt,
      planContext,
    )
    const conversation = await loadConversation(deps.prisma, context.run.threadId)
    const memories = await retrieveRelevantMemories(deps, context, payload, prompt)
    const injectedRecallIds = memories.flatMap((memory) =>
      memory.recallId ? [memory.recallId] : [],
    )
    const memoryContext = buildMemoryContext(memories)

    if (injectedRecallIds.length > 0) {
      await markRecallsInjected(injectedRecallIds, deps.searchConfig.pool)
    }

    const modelMessages = buildModelPrompt(
      conversation,
      context,
      prompt,
      toolOutputs,
      childAgentName,
      memoryContext,
    )

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })
    streamStarted = true

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

    const referencedRecallIds = detectReferencedRecallIds(responseText, memories)
    if (referencedRecallIds.length > 0) {
      await markRecallsReferenced(referencedRecallIds, deps.searchConfig.pool)
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

    await publishMessageCreated(deps.realtimeTransport, context, {
      content: responseText,
      messageId: assistantMessage.id,
      role: 'assistant',
    })

    await updateRunStatus(deps.prisma, context.run.id, 'completed')
    await updateTaskStatus(deps.prisma, context.task.id, 'done')
    await markRunPlanFinished(deps.prisma, {
      artifacts: {
        childAgentName,
        toolOutputs,
      },
      planId: planContext.planId,
      rootStepId: planContext.rootStepId,
      success: true,
      summary: responseText.slice(0, 500),
    })
    await setAgentStatus(deps.prisma, context.agent.id, 'idle')
    await publishRunUpdated(deps.realtimeTransport, context, 'completed')
    await publishTaskUpdated(deps.realtimeTransport, buildScopes(context), context.task.id, 'done')
    await publishAgentStatus(deps.realtimeTransport, context, {
      currentRunId: context.run.id,
      status: 'idle',
    })
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Run execution failed unexpectedly'

    if (streamStarted) {
      const fallbackMessageId = `run-error:${context.run.id}`
      let terminalMessageId = fallbackMessageId

      try {
        const errorMessage = await deps.prisma.message.create({
          data: {
            agentId: context.agent.id,
            content: `I hit an error while processing this request: ${messageText}`,
            role: 'assistant',
            threadId: context.run.threadId,
          },
        })

        terminalMessageId = errorMessage.id

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
          messageId: terminalMessageId,
          runId: parseRunId(context.run.id),
        })
      } catch (streamError) {
        console.error('Failed to publish terminal stream event', streamError)
      }
    }

    await updateRunStatus(deps.prisma, context.run.id, 'failed')
    await updateTaskStatus(deps.prisma, context.task.id, 'failed')
    if (planContext) {
      await markRunPlanFinished(deps.prisma, {
        artifacts: {
          error: messageText,
        },
        planId: planContext.planId,
        rootStepId: planContext.rootStepId,
        success: false,
        summary: messageText.slice(0, 500),
      })
    }
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

    throw error
  }
}
