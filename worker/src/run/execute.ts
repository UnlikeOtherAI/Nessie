import { Prisma, type PrismaClient } from '@prisma/client'
import {
  markRecallsInjected,
  markRecallsReferenced,
  resolveAccessibleScopes,
  searchAndLogThoughtsInScopes,
  type ScopeResolutionMode,
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
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import {
  attributionFromActorContext,
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_IDS,
  checkBudget,
  recordConnectorUsage,
  type ConnectorType,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
  type RunExecuteJobPayload,
  type RunStatus,
  type TaskStatus,
  type WsScope,
} from '@nessie/schemas'
import { executeBuiltinTool } from './tools.js'
import { authorizeToolCall, resolveAgentTools, type ToolDenialReason } from './tool-policy.js'
import { runAgenticLoop, DEFAULT_BUDGET } from './agentic-loop.js'
import { buildMcpToolset } from './mcp-toolset.js'
import { runDelegate } from './delegate.js'
import { enqueueQueueJob } from '../queue.js'
import {
  markDelegationStepFinished,
  ensureRunPlanContext,
  markRunPlanFinished,
  markRunPlanStarted,
} from './plans.js'
import { markWorkflowStepRunFinished } from './workflows.js'
import { persistInvocationLedgerEvents, runInferenceGraph } from './inference.js'
import { enqueueRunMemoryConsolidation } from './memory-consolidation.js'

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
    agentKind: 'personal_assistant' | 'shared'
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
    systemChannelType: 'personal_assistant' | null
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
const POLICY_SCOPE_WEIGHT: Record<string, number> = {
  organization: 0,
  project: 1,
  team: 2,
  channel: 3,
  agent: 4,
  tool: 5,
  user: 6,
}

type RetrievedMemory = Pick<SearchResult, 'content' | 'recallId'>

type WorkerPolicyRule = {
  action: string
  bindings: Array<{
    actorId: string
    actorType: string
  }>
  conditions: unknown
  effect: string
  id: string
  priority: number
  resourceType: string
  scope: string
  scopeId: string
}

type ToolPolicyEvaluation =
  | {
      allowed: true
      policyRuleId?: string
      policySource: string
    }
  | {
      allowed: false
      approvalActionType?: string
      policyRuleId?: string
      policySource: string
      reason: 'approval_required' | 'explicit_policy_deny'
    }

type ToolDeniedOutputReason =
  | ToolDenialReason
  | 'approval_required'
  | 'explicit_policy_deny'

const buildScopes = (context: RunContext): WsScope[] => [
  ...buildScopesForAgent(context.channel, context.agent.id),
]

const buildToolActorContext = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): AuthorizedActionContext =>
  withActionContext(actorContext, {
    agentId: parseAgentId(context.agent.id),
    channelId: parseChannelId(context.channel.id),
    taskId: parseTaskId(context.task.id),
    threadId: parseThreadId(context.run.threadId),
    toolId: toolName,
  })

const evaluatePolicyConditions = (conditions: Record<string, unknown> | null): boolean => {
  if (!conditions) {
    return true
  }

  const timeWindow = conditions['timeWindow']
  if (timeWindow && typeof timeWindow === 'object' && !Array.isArray(timeWindow)) {
    const candidate = timeWindow as {
      daysOfWeek?: unknown
      endHour?: unknown
      startHour?: unknown
    }
    if (
      typeof candidate.startHour !== 'number'
      || typeof candidate.endHour !== 'number'
      || !Array.isArray(candidate.daysOfWeek)
    ) {
      return false
    }

    const now = new Date()
    const hour = now.getUTCHours()
    const day = now.getUTCDay()
    if (!candidate.daysOfWeek.includes(day)) {
      return false
    }
    if (candidate.startHour <= candidate.endHour) {
      return hour >= candidate.startHour && hour < candidate.endHour
    }
    return hour >= candidate.startHour || hour < candidate.endHour
  }

  return true
}

const actorMatchesPolicyBinding = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  binding: WorkerPolicyRule['bindings'][number],
): boolean => {
  if (binding.actorId === '*') {
    return true
  }
  if (
    binding.actorType === actorContext.actor.actorType
    && binding.actorId === actorContext.actor.actorId
  ) {
    return true
  }
  if (binding.actorType === 'role' && actorContext.actor.roles?.includes(binding.actorId)) {
    return true
  }
  if (binding.actorType === 'agent' && binding.actorId === context.agent.id) {
    return true
  }
  return false
}

const buildPolicyScopeIds = (
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): string[] => [
  actorContext.tenant.organizationId,
  ...(actorContext.tenant.projectId ? [actorContext.tenant.projectId] : []),
  ...(actorContext.tenant.teamId ? [actorContext.tenant.teamId] : []),
  context.channel.id,
  context.agent.id,
  toolName,
  actorContext.actor.actorId,
]

const evaluateToolInvokePolicy = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  context: RunContext,
  toolName: string,
): Promise<ToolPolicyEvaluation> => {
  const rules = await prisma.policyRule.findMany({
    where: {
      action: 'invoke',
      organizationId: context.channel.organizationId,
      resourceType: 'tool',
      scopeId: { in: buildPolicyScopeIds(actorContext, context, toolName) },
    },
    include: { bindings: true },
    orderBy: [{ priority: 'asc' }],
  }) as WorkerPolicyRule[]

  const matchingRules = rules
    .filter((rule) =>
      rule.bindings.some((binding) => actorMatchesPolicyBinding(actorContext, context, binding)),
    )
    .sort((left, right) => {
      const leftWeight = POLICY_SCOPE_WEIGHT[left.scope] ?? 99
      const rightWeight = POLICY_SCOPE_WEIGHT[right.scope] ?? 99
      if (leftWeight !== rightWeight) {
        return leftWeight - rightWeight
      }
      return left.priority - right.priority
    })

  let lastAllow: WorkerPolicyRule | null = null
  for (const rule of matchingRules) {
    const conditions = rule.conditions as Record<string, unknown> | null
    if (!evaluatePolicyConditions(conditions)) {
      continue
    }

    if (rule.effect === 'deny') {
      return {
        allowed: false,
        policyRuleId: rule.id,
        policySource: `${rule.scope}:${rule.scopeId}/deny`,
        reason: 'explicit_policy_deny',
      }
    }

    if (rule.effect === 'allow') {
      if (conditions?.['requiresApproval'] && !actorContext.approval?.approvalProof) {
        return {
          allowed: false,
          approvalActionType:
            typeof conditions['approvalActionType'] === 'string'
              ? conditions['approvalActionType']
              : undefined,
          policyRuleId: rule.id,
          policySource: `${rule.scope}:${rule.scopeId}/allow`,
          reason: 'approval_required',
        }
      }
      lastAllow = rule
    }
  }

  if (lastAllow) {
    return {
      allowed: true,
      policyRuleId: lastAllow.id,
      policySource: `${lastAllow.scope}:${lastAllow.scopeId}/allow`,
    }
  }

  return { allowed: true, policySource: 'none' }
}

const emitWorkerAuditEvent = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: {
    action: 'policy.evaluated'
    metadata?: Record<string, unknown>
    outcome: 'denied' | 'error' | 'success'
    reason?: string
    resourceId?: string
    resourceType: string
    tenantOverride?: {
      channelId?: string | null
      organizationId: string
      projectId?: string | null
      teamId?: string | null
    }
  },
): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
        channelId:
          input.tenantOverride?.channelId
          ?? actorContext.actionContext.channelId
          ?? actorContext.tenant.channelId
          ?? null,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
        organizationId: input.tenantOverride?.organizationId ?? actorContext.tenant.organizationId,
        outcome: input.outcome,
        projectId: input.tenantOverride?.projectId ?? actorContext.tenant.projectId ?? null,
        reason: input.reason ?? null,
        requestId: actorContext.actionContext.requestId,
        resourceId: input.resourceId ?? null,
        resourceType: input.resourceType,
        teamId:
          input.tenantOverride?.teamId
          ?? actorContext.tenant.teamId
          ?? actorContext.actionContext.teamId
          ?? null,
      },
    })
  } catch {
    console.error('[worker:audit] Failed to emit audit event:', input.action, input.resourceType)
  }
}

const validateRunActorContext = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  context: RunContext,
): Promise<void> => {
  const mismatches: string[] = []

  if (actorContext.tenant.organizationId !== context.channel.organizationId) {
    mismatches.push('tenant.organizationId')
  }
  if (actorContext.tenant.channelId && actorContext.tenant.channelId !== context.channel.id) {
    mismatches.push('tenant.channelId')
  }
  if (
    actorContext.actionContext.channelId
    && actorContext.actionContext.channelId !== context.channel.id
  ) {
    mismatches.push('actionContext.channelId')
  }
  if (actorContext.actionContext.agentId && actorContext.actionContext.agentId !== context.agent.id) {
    mismatches.push('actionContext.agentId')
  }
  if (actorContext.actionContext.taskId && actorContext.actionContext.taskId !== context.task.id) {
    mismatches.push('actionContext.taskId')
  }
  if (
    actorContext.actionContext.threadId
    && actorContext.actionContext.threadId !== context.run.threadId
  ) {
    mismatches.push('actionContext.threadId')
  }

  if (mismatches.length === 0) {
    return
  }

  await emitWorkerAuditEvent(prisma, actorContext, {
    action: 'policy.evaluated',
    metadata: {
      agentId: context.agent.id,
      channelId: context.channel.id,
      mismatches,
      runId: context.run.id,
      source: 'worker_actor_context_validation',
      taskId: context.task.id,
      threadId: context.run.threadId,
    },
    outcome: 'denied',
    reason: 'actor_context_mismatch',
    resourceId: context.run.id,
    resourceType: 'run',
    tenantOverride: {
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      projectId: null,
      teamId: null,
    },
  })

  throw new Error('Actor context does not match the run execution context.')
}

const toolDeniedResult = (
  toolName: string,
  args: Record<string, unknown>,
  input: {
    approvalActionType?: string
    message: string
    policyRuleId?: string
    policySource?: string
    reason: ToolDeniedOutputReason
  },
): { inputSummary: string; output: string; success: false } => ({
  inputSummary: JSON.stringify(args).slice(0, 200),
  output: JSON.stringify({
    approvalActionType: input.approvalActionType,
    message: input.message,
    policyRuleId: input.policyRuleId,
    policySource: input.policySource,
    reason: input.reason,
    toolId: toolName,
    type: 'tool_denied',
  }),
  success: false,
})

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

// Builtin registry entries only change on deploy, so seeding them on every run
// is N pointless writes. Seed each organisation at most once per worker process
// (lazily on its first run) and read enabled entries on every run thereafter.
const seededBuiltinOrganizations = new Set<string>()

const seedBuiltinToolRegistry = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> => {
  if (seededBuiltinOrganizations.has(organizationId)) {
    return
  }

  await Promise.all(
    BUILTIN_TOOL_DEFINITIONS.map((tool) =>
      prisma.toolRegistryEntry.upsert({
        where: {
          organizationId_scopeKey_toolId: {
            organizationId,
            scopeKey: BUILTIN_TOOL_SCOPE_KEY,
            toolId: tool.id,
          },
        },
        create: {
          builtin: true,
          description: tool.description,
          // Builtins ship with short one-line descriptions that double as the
          // human-readable summary required by spec §3.1.
          overview: tool.description,
          enabled: true,
          handlerKind: 'builtin',
          label: tool.label,
          organizationId,
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

  seededBuiltinOrganizations.add(organizationId)
}

const loadAllowedToolIds = async (
  prisma: PrismaClient,
  context: RunContext,
): Promise<Set<string>> => {
  await seedBuiltinToolRegistry(prisma, context.channel.organizationId)

  const enabledRegistryEntries = await prisma.toolRegistryEntry.findMany({
    where: {
      builtin: true,
      enabled: true,
      organizationId: context.channel.organizationId,
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

const isSuppressedMemory = (metadata: unknown): boolean => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false
  }

  const record = metadata as Record<string, unknown>
  return record['suppressed'] === true || record['suppressionState'] === 'suppressed'
}

const buildScopesForAgent = (
  channel: RunContext['channel'],
  agentId: string,
): WsScope[] => [
  {
    kind: 'channel',
    channelId: parseChannelId(channel.id),
  },
  ...(channel.systemChannelType === 'personal_assistant'
    ? []
    : [
        {
          kind: 'organization' as const,
          organizationId: parseOrganizationId(channel.organizationId),
        },
        {
          kind: 'agent' as const,
          agentId: parseAgentId(agentId),
        },
      ]),
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
      channelId: parseChannelId(context.channel.id),
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

// Atomic start claim: flips a still-claimable run to `running` in a single
// statement. A terminal run (completed/failed/cancelled) matches nothing and
// returns count === 0, so a re-driven job for a finished run is not resurrected.
// `running` is kept in the WHERE because the queue lock guarantees a single
// worker per job, so a re-entrant claim of the same in-flight run is benign.
const claimRunForExecution = async (
  prisma: PrismaClient,
  runId: string,
): Promise<boolean> => {
  const { count } = await prisma.run.updateMany({
    where: { id: runId, status: { in: ['pending', 'running'] } },
    data: { status: 'running', startedAt: new Date() },
  })
  return count === 1
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
          agentKind: true,
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
              systemChannelType: true,
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

// Builtin tools that reach an external/third-party service. Each call is billed
// to the connector usage ledger (sibling to the AI token ledger) so non-AI
// third-party usage is attributable per org/channel/agent/run. Tools not listed
// here are internal (messaging, files, scheduling) and are not connector usage.
const CONNECTOR_TYPE_BY_TOOL: Record<string, ConnectorType> = {
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  http_fetch: 'http',
}

const recordToolEnd = async (
  deps: ExecutionDependencies,
  context: RunContext,
  actorContext: AuthorizedActionContext,
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

  const connectorType = CONNECTOR_TYPE_BY_TOOL[input.toolName]
  if (connectorType) {
    await recordConnectorUsage(deps.prisma, {
      attribution: attributionFromActorContext(actorContext, {
        agentId: context.agent.id,
        runId: context.run.id,
      }),
      event: {
        connectorType,
        operation: input.toolName,
        success: input.success,
        latencyMs: input.durationMs,
      },
    }).catch(() => {
      // best-effort billing capture; never break the run on a ledger failure
    })
  }

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
  const effectiveUserId =
    payload.actorContext.actionContext.effectiveUserId
    ?? (payload.actorContext.actor.actorType === 'user'
      ? payload.actorContext.actor.actorId
      : undefined)

  const isPersonalAssistant =
    context.channel.systemChannelType === 'personal_assistant'
    || context.agent.agentKind === 'personal_assistant'

  // The personal assistant acts as its owner, so it recalls everything that
  // user can; without a user there is nothing to act as.
  if (isPersonalAssistant && !effectiveUserId) {
    return []
  }

  const mode: ScopeResolutionMode = isPersonalAssistant
    ? 'personal_assistant'
    : effectiveUserId
      ? 'user_shared'
      : 'autonomous'

  try {
    const scopes = await resolveAccessibleScopes(
      {
        agentId: context.agent.id,
        mode,
        organizationId: context.channel.organizationId,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig.pool,
    )

    if (scopes.audienceTypes.length === 0) {
      return []
    }

    const results = await searchAndLogThoughtsInScopes(
      {
        audienceIds: scopes.audienceIds,
        audienceTypes: scopes.audienceTypes,
        channelId: context.channel.id,
        includeReasoning: false,
        limit: MAX_MEMORY_RESULTS,
        organizationId: context.channel.organizationId,
        query: prompt,
        runningAgentId: context.agent.id,
        sessionId: payload.actorContext.actionContext.sessionId,
        userId: effectiveUserId ?? null,
      },
      deps.searchConfig,
    )

    return results.filter((result) => !isSuppressedMemory(result.metadata))
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
    `Current date and time: ${new Date().toISOString()} (UTC). When the user gives a `
      + 'relative or wall-clock time, resolve it against this; treat wall-clock times '
      + 'as UTC unless the user states a timezone.',
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
  // Idempotency guard: skip if this run already reached a terminal state.
  //
  // We deliberately do NOT skip `running` runs: the queue renews each job's
  // lock while its handler is in flight (see PgQueueProvider.withLockRenewal),
  // so a live worker's run is never re-claimed concurrently. A run that is
  // still `running` when re-claimed therefore means the previous worker
  // crashed, and re-execution is the intended recovery path.
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
    await validateRunActorContext(deps.prisma, payload.actorContext, context)

    // Budget gate: refuse to spend on a model when the org is over its monthly cap.
    // Only a live human conversational turn (payload.interactive) is exempt by
    // default; automations — triggers (even manually fired), subtasks, mailbox,
    // scheduled runs — leave interactive unset and are throttled.
    const budgetDecision = await checkBudget(
      deps.prisma,
      {
        organizationId: payload.actorContext.tenant.organizationId,
        projectId: payload.actorContext.tenant.projectId,
        teamId: payload.actorContext.tenant.teamId,
      },
      { isHuman: payload.interactive === true },
    )
    // When over a degrade budget, run on the cheaper model instead of the agent's.
    const budgetModelOverride =
      budgetDecision.action === 'degrade'
        ? { model: budgetDecision.model, provider: budgetDecision.provider }
        : null
    if (budgetModelOverride) {
      console.warn(
        `[worker] run ${context.run.id} degraded by budget to ${budgetModelOverride.provider}/${budgetModelOverride.model}`,
      )
    }
    if (budgetDecision.action === 'block') {
      const notice = `⚠️ ${budgetDecision.reason} — this request was not run.`
      const blockMessage = await deps.prisma.message.create({
        data: {
          agentId: context.agent.id,
          content: notice,
          role: 'assistant',
          threadId: context.run.threadId,
        },
      })
      await publishMessageCreated(deps.realtimeTransport, context, {
        content: blockMessage.content,
        messageId: blockMessage.id,
        role: blockMessage.role,
      })
      await updateRunStatus(deps.prisma, context.run.id, 'failed')
      await updateTaskStatus(deps.prisma, context.task.id, 'failed')
      await setAgentStatus(deps.prisma, context.agent.id, 'idle')
      await publishRunUpdated(deps.realtimeTransport, context, 'failed')
      await publishTaskUpdated(
        deps.realtimeTransport,
        buildScopes(context),
        context.task.id,
        'failed',
      )
      console.warn(`[worker] run ${context.run.id} blocked by budget: ${budgetDecision.reason}`)
      return
    }

    planContext = await ensureRunPlanContext(deps.prisma, {
      agentId: context.agent.id,
      channelId: context.channel.id,
      createdByActorId: payload.actorContext.actor.actorId,
      createdByActorType: payload.actorContext.actor.actorType,
      goal: prompt,
      organizationId: context.channel.organizationId,
      runId: context.run.id,
    })

    const claimed = await claimRunForExecution(deps.prisma, context.run.id)
    if (!claimed) {
      console.log(`[worker] run ${context.run.id} already claimed or terminal; skipping`)
      return
    }
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

    const mcpToolset = await buildMcpToolset(
      deps.prisma,
      context.channel.organizationId,
      toolPolicy,
    )

    const subAgentBuiltinDescriptors = toolDefs.filter((d) => d.toolName !== 'delegate')
    const subAgentBuiltinIds = new Set(
      [...resolvedToolIds].filter((id) => id !== 'delegate'),
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
    const subAgentInvocations: InvocationRecord[] = []

    type InferenceCallbacks = {
      onVisibleReasoningDelta: (chunk: string) => Promise<void>
      onVisibleTextDelta: (chunk: string) => Promise<void>
    }
    const mainInferenceCallbacks: InferenceCallbacks = {
      onVisibleReasoningDelta: async (chunk) => {
        await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.reasoning', {
          content: chunk,
          runId: parseRunId(context.run.id),
        })
      },
      onVisibleTextDelta: async (chunk) => {
        currentTurnStreamed = true
        await deps.realtimeTransport.publishSse(context.run.threadId, 'stream.delta', {
          content: chunk,
          runId: parseRunId(context.run.id),
        })
      },
    }
    const silentInferenceCallbacks: InferenceCallbacks = {
      onVisibleReasoningDelta: async () => undefined,
      onVisibleTextDelta: async () => undefined,
    }

    const runInferenceWithCallbacks = async (
      messages: ProviderMessage[],
      tools: ToolSchemaDescriptor[],
      callbacks: InferenceCallbacks,
    ) => {
      const mpr = await runInferenceGraph(deps.prisma, {
        actorContext: payload.actorContext,
        agent: {
          id: context.agent.id,
          model: budgetModelOverride?.model ?? context.agent.model,
          provider: budgetModelOverride?.provider ?? context.agent.provider,
          routingProfileId: null,
        },
        baseMessages: messages,
        modelConfig: runtimeModelConfig,
        onVisibleReasoningDelta: callbacks.onVisibleReasoningDelta,
        onVisibleTextDelta: callbacks.onVisibleTextDelta,
        organizationId: context.channel.organizationId,
        toolChoice: 'auto',
        tools,
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
        provider: (mpr.invocations[0]?.provider ?? 'openai') as 'openai' | 'minimax' | 'kimi' | 'openai-compatible',
        requestId: mpr.requestId,
        toolCalls: mpr.toolCalls,
      }
    }

    const runMainInference = (messages: ProviderMessage[], tools: ToolSchemaDescriptor[]) => {
      currentTurnStreamed = false
      return runInferenceWithCallbacks(messages, tools, mainInferenceCallbacks)
    }

    const runSubAgentInference = (messages: ProviderMessage[], tools: ToolSchemaDescriptor[]) =>
      runInferenceWithCallbacks(messages, tools, silentInferenceCallbacks)

    const buildBuiltinCtx = (toolActorContext: AuthorizedActionContext) => ({
      agentId: context.agent.id,
      actorContext: toolActorContext,
      channel: {
        id: context.channel.id,
        organizationId: parseOrganizationId(context.channel.organizationId),
        systemChannelType: context.channel.systemChannelType,
      },
      memoryCaptureConfig: {
        modelClient: deps.modelClient,
        pool: deps.searchConfig.pool,
      },
      prisma: deps.prisma,
      realtimeTransport: deps.realtimeTransport,
      run: {
        id: context.run.id,
        messageId: payload.messageId,
        threadId: context.run.threadId,
      },
    })

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
          await recordToolEnd(deps, context, payload.actorContext, {
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
        const toolActorContext = buildToolActorContext(payload.actorContext, context, toolName)
        if (toolName === 'delegate') {
          const result = await runDelegate(args, {
            mcpToolset,
            runInference: runSubAgentInference,
            executeBuiltinTool: (n, a) => executeBuiltinTool(n, a, buildBuiltinCtx(toolActorContext)),
            builtinDescriptors: subAgentBuiltinDescriptors,
            allowedBuiltinIds: subAgentBuiltinIds,
          })
          subAgentInvocations.push(...result.invocations)
          return {
            inputSummary: result.inputSummary,
            output: result.output,
            success: result.success,
          }
        }
        const registryDecision = authorizeToolCall(
          toolName,
          allowedToolIds,
          BUILTIN_TOOL_DEFINITIONS,
          toolPolicy,
          context.agent.parentAgentId,
        )

        if (!registryDecision.allowed || !resolvedToolIds.has(toolName)) {
          const message = `Tool "${toolName}" is not allowed for this agent.`
          await emitWorkerAuditEvent(deps.prisma, toolActorContext, {
            action: 'policy.evaluated',
            metadata: {
              agentId: context.agent.id,
              runId: context.run.id,
              source: 'worker_tool_authorization',
              taskId: context.task.id,
              toolId: toolName,
            },
            outcome: 'denied',
            reason: registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason,
            resourceId: toolName,
            resourceType: 'tool',
          })
          return toolDeniedResult(toolName, args, {
            message,
            reason: registryDecision.allowed ? 'tool_not_granted' : registryDecision.reason,
          })
        }

        const policyDecision = await evaluateToolInvokePolicy(
          deps.prisma,
          toolActorContext,
          context,
          toolName,
        )
        if (!policyDecision.allowed) {
          const message =
            policyDecision.reason === 'approval_required'
              ? `Tool "${toolName}" requires approval before it can run.`
              : `Tool "${toolName}" was denied by policy.`
          await emitWorkerAuditEvent(deps.prisma, toolActorContext, {
            action: 'policy.evaluated',
            metadata: {
              agentId: context.agent.id,
              approvalActionType: policyDecision.approvalActionType,
              policyRuleId: policyDecision.policyRuleId,
              policySource: policyDecision.policySource,
              runId: context.run.id,
              source: 'worker_tool_policy',
              taskId: context.task.id,
              toolId: toolName,
            },
            outcome: 'denied',
            reason: policyDecision.reason,
            resourceId: toolName,
            resourceType: 'tool',
          })
          return toolDeniedResult(toolName, args, {
            approvalActionType: policyDecision.approvalActionType,
            message,
            policyRuleId: policyDecision.policyRuleId,
            policySource: policyDecision.policySource,
            reason: policyDecision.reason,
          })
        }
        return executeBuiltinTool(toolName, args, buildBuiltinCtx(toolActorContext))
      },
      initialMessages,
      runInference: (messages) => runMainInference(messages, toolDefs),
      tools: toolDefs,
    })

    if (subAgentInvocations.length > 0) {
      loopResult.invocations.push(...subAgentInvocations)
    }

    const responseText = stripLeadingSectionTag(loopResult.finalText)

    await persistInvocationLedgerEvents(deps.prisma, {
      actorContext: payload.actorContext,
      agentId: context.agent.id,
      runId: context.run.id,
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
      agentId: parseAgentId(context.agent.id),
      content: responseText,
      createdAt: assistantMessage.createdAt.toISOString(),
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
    // Memory consolidation is best-effort: a failure to enqueue it must never
    // turn an already-completed run into a failed one (the outer catch would).
    try {
      await enqueueRunMemoryConsolidation(deps.prisma, {
        runId: parseRunId(context.run.id),
        taskId: parseTaskId(context.task.id),
      })
    } catch (consolidationError) {
      console.error(
        '[worker.memory] failed to enqueue run memory consolidation for run',
        context.run.id,
        consolidationError,
      )
    }
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
      let terminalContent = `I hit an error while processing this request: ${messageText}`
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
