import type { PrismaClient } from '@prisma/client'
import {
  markRecallsInjected,
  markRecallsReferenced,
  searchAndLogThoughts,
  type SearchExecutionConfig,
  type SearchResult,
} from '@nessie/memory'
import { loadConfig } from '@nessie/config'
import type {
  InvocationRecord,
  ModelClient,
  PgRealtimeTransport,
  ProviderMessage,
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
import { executeBuiltinTool } from './tools.js'
import { resolveAgentTools } from './tool-policy.js'
import { runAgenticLoop, DEFAULT_BUDGET } from './agentic-loop.js'
import { enqueueQueueJob } from '../queue.js'
import {
  markDelegationStepFinished,
  ensureRunPlanContext,
  markRunPlanFinished,
  markRunPlanStarted,
} from './plans.js'
import { markWorkflowStepRunFinished } from './workflows.js'
import { persistInvocationLedgerEvents, runInferenceGraph } from './inference.js'

const runtimeModelConfig = loadConfig().model

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
    model: string | null
    parentAgentId: string | null
    provider: string | null
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

const MAX_MEMORY_RESULTS = 5
const MAX_MEMORY_CONTEXT_LENGTH = 220
const MIN_REFERENCE_TOKENS = 5
const BUILTIN_TOOL_SCOPE_KEY = 'builtin'

type RetrievedMemory = Pick<SearchResult, 'content' | 'recallId'>

const buildScopes = (context: RunContext): WsScope[] => [
  ...buildScopesForAgent(context.channel, context.agent.id),
]

const maybeContinueParentWorkflow = async (
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
      .filter((toolId) => BUILTIN_TOOL_IDS.has(toolId)),
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

const LEADING_SECTION_TAG_REGEX = /^\s*\[[A-Za-z][A-Za-z\s/-]{0,24}\]\s*/

export const stripLeadingSectionTag = (text: string): string =>
  text.replace(LEADING_SECTION_TAG_REGEX, '')

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
          model: true,
          name: true,
          parentAgentId: true,
          provider: true,
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
        outputAudienceId: context.channel.id,
        outputAudienceType: 'channel',
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
  memoryContext: string | null,
): ProviderMessage[] => {
  const systemParts = [
    `You are ${context.agent.name}.`,
    context.agent.systemPrompt?.trim() ?? '',
    'You have access to tools. Use them when needed to answer the request accurately.',
    'Call tools by their function name. Do not fabricate tool output — always call the tool.',
    'When you have enough information, respond directly without calling more tools.',
    'Use relevant memory context when it helps, but prefer the latest explicit user instructions on conflict.',
    'Keep the answer concise and concrete.',
    [
      'Write like a person in a chat thread, not a help-desk bot.',
      '- No sycophantic openers ("Sure!", "Absolutely!", "Great question!", "Of course!").',
      '- No restating what the user just asked before answering.',
      [
        '- No closing offers to help further ("feel free to ask", "let me know if',
        'you need anything else", "happy to help", "hope this helps"). The user',
        'is in a chat; they can just ask again.',
      ].join(' '),
      '- No unsolicited summaries of your own reply.',
      [
        '- No bracketed section labels at the start of a reply ("[Scene]",',
        '"[Setting]", "[Narration]", "[Note]", "[OOC]", etc.). Write the prose',
        'or answer directly.',
      ].join(' '),
      '- Match the register of the message you are replying to. Short casual question → short casual answer.',
    ].join('\n'),
  ].filter((part) => part.length > 0)

  const messages: ProviderMessage[] = [{ content: systemParts.join('\n\n'), role: 'system' }]

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

    const agentRecord = await deps.prisma.agent.findUnique({
      where: { id: context.agent.id },
      select: { toolPolicy: true, parentAgentId: true },
    })
    const toolPolicy = agentRecord?.toolPolicy as Record<string, boolean> | null ?? null
    const { descriptors: toolDefs, allowedIds: resolvedToolIds } = resolveAgentTools(
      allowedToolIds,
      BUILTIN_TOOL_DEFINITIONS,
      toolPolicy,
      context.agent.parentAgentId,
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

    const initialMessages = buildModelPrompt(
      conversation,
      context,
      prompt,
      memoryContext,
    )

    await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.start', {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
      threadId: parseThreadId(context.run.threadId),
    })
    streamStarted = true
    let currentTurnStreamed = false

    const loopResult = await runAgenticLoop({
      budget: DEFAULT_BUDGET,
      callbacks: {
        onIterationStart: async (iteration) => {
          await deps.realtimeTransport.publishWs(buildScopes(context), {
            data: {
              agentId: parseAgentId(context.agent.id),
              iteration,
              runId: parseRunId(context.run.id),
            },
            event: 'agent.iteration',
          })
        },
        onToolCallStart: async (toolName, _args) => {
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
              inputSummary: JSON.stringify(_args).slice(0, 200),
              runId: parseRunId(context.run.id),
              toolName,
            },
            event: 'agent.tool.start',
          })
        },
        onToolCallEnd: async (toolName, result, durationMs, success, inputSummary, startedAt) => {
          await recordToolEnd(deps, context, {
            durationMs,
            inputSummary,
            outputPreview: result.slice(0, 1200),
            startedAt,
            success,
            toolName,
          })
          await setAgentStatus(deps.prisma, context.agent.id, 'thinking')
          await publishAgentStatus(deps.realtimeTransport, context, {
            currentRunId: context.run.id,
            status: 'thinking',
          })
        },
        onTextDelta: async (delta) => {
          if (currentTurnStreamed) {
            currentTurnStreamed = false
            return
          }
          await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
            content: delta,
            runId: parseRunId(context.run.id),
          })
        },
        onBudgetExhausted: async (reason) => {
          console.warn(`[worker] Agentic loop budget exhausted: ${reason} for run ${context.run.id}`)
        },
      },
      executeTool: async (toolName, args) => {
        if (!resolvedToolIds.has(toolName)) {
          return { output: `Tool "${toolName}" is not allowed for this agent.`, success: false, inputSummary: JSON.stringify(args).slice(0, 200) }
        }
        return executeBuiltinTool(toolName, args)
      },
      initialMessages,
      runInference: async (messages) => {
        currentTurnStreamed = false
        const mpr = await runInferenceGraph(deps.prisma, {
          actorContext: payload.actorContext,
          agent: {
            id: context.agent.id,
            model: context.agent.model,
            provider: context.agent.provider,
            routingProfileId: null,
          },
          baseMessages: messages,
          modelConfig: runtimeModelConfig,
          onVisibleTextDelta: async (chunk) => {
            currentTurnStreamed = true
            await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
              content: chunk,
              runId: parseRunId(context.run.id),
            })
          },
          organizationId: context.channel.organizationId,
          toolChoice: 'auto',
          tools: toolDefs,
        })
        if (
          mpr.status !== 'completed'
          || (!mpr.finalAnswer?.trim() && mpr.toolCalls.length === 0)
        ) {
          throw new Error(mpr.failure?.message ?? 'Inference execution produced no final answer')
        }
        return {
          correlationId: mpr.correlationId,
          finishReason: mpr.invocations[0]?.finishReason,
          invocations: mpr.invocations as unknown as InvocationRecord[],
          model: mpr.invocations[0]?.model ?? '',
          outputText: mpr.finalAnswer ?? '',
          provider: (mpr.invocations[0]?.provider ?? 'openai') as 'openai' | 'minimax' | 'openai-compatible',
          requestId: mpr.requestId,
          toolCalls: mpr.toolCalls,
        }
      },
      tools: toolDefs,
    })

    const responseText = stripLeadingSectionTag(loopResult.finalText)

    await persistInvocationLedgerEvents(deps.prisma, {
      actorContext: payload.actorContext,
      agentId: context.agent.id,
      invocations: loopResult.invocations,
    })

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
        iterations: loopResult.iterations,
        toolCallsUsed: loopResult.toolCallsUsed,
      },
      planId: planContext.planId,
      rootStepId: planContext.rootStepId,
      success: true,
      summary: responseText.slice(0, 500),
    })
    await markDelegationStepFinished(deps.prisma, {
      artifacts: {
        responseText,
        runId: context.run.id,
        taskId: context.task.id,
        iterations: loopResult.iterations,
      },
      planId: payload.parentPlanId,
      planStepId: payload.parentPlanStepId,
      success: true,
    })
    await maybeContinueParentWorkflow(deps, payload, {
      output: {
        responseText,
        runId: context.run.id,
        taskId: context.task.id,
      },
      success: true,
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

    throw error
  }
}
