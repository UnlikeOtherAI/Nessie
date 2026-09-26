import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS, type InferenceResult, type InvocationRecord } from '@nessie/runtime'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { Pool } from 'pg'

import { createConsumedSourceSink } from './disclosure-basis.js'
import { runExecutionAgentLoop } from './agent-loop.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutorMcpCatalogAnswer } from '../executor-mcp-catalog.js'
import type { ExecutorToolset } from '../executor-toolset.js'
import type { McpToolset } from '../mcp-toolset.js'
import type { AgenticToolResult } from '../tools.js'
import { reviewableToolSurface } from './auto-review.js'

/**
 * Regression coverage for the pre-dispatch authorization gate (security
 * boundary hardening, Workstream 0 / SB-01): every tool path — main builtin,
 * main MCP, main executor, delegated builtin, delegated MCP — is authorized
 * before any dispatcher runs, so a policy deny or an approval requirement
 * intercepts each of them identically.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const TEAM_ID = '44444444-4444-4444-8444-444444444444'
const AGENT_ID = '55555555-5555-4555-8555-555555555555'
const RUN_ID = '66666666-6666-4666-8666-666666666666'
const TASK_ID = '77777777-7777-4777-8777-777777777777'
const THREAD_ID = '88888888-8888-4888-8888-888888888888'
const USER_ID = '99999999-9999-4999-8999-999999999999'

const actorContext = (): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: USER_ID, roles: ['member'] },
  tenant: {
    organizationId: parseOrganizationId(ORG_ID),
    projectId: parseProjectId(PROJECT_ID),
    teamId: parseTeamId(TEAM_ID),
  },
  actionContext: { requestId: 'req-test' },
})

const runContext = (): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: AGENT_ID,
    model: null,
    name: 'Test Agent',
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: CHANNEL_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    systemChannelType: null,
    visibility: 'public',
  },
  consumedSources: createConsumedSourceSink(),
  run: { createdAt: new Date(), id: RUN_ID, replyPlacement: null, threadId: THREAD_ID },
  task: { id: TASK_ID },
})

type FakePrisma = {
  approvalRequests: Array<Record<string, unknown>>
  auditLog: { createCalls: number; entries: Array<Record<string, unknown>> }
  taskEvents: Array<Record<string, unknown>>
  prisma: ExecutionDependencies['prisma']
  ruleLog: string[]
  setRules: (rules: Array<Record<string, unknown>>) => void
  toolEffects: Map<string, Record<string, unknown>>
}

const effectKey = (row: { runId: string; toolCallId: string }): string =>
  `${row.runId}:${row.toolCallId}`

const fakePrisma = (): FakePrisma => {
  let rules: Array<Record<string, unknown>> = []
  const state = {
    approvalRequests: [] as Array<Record<string, unknown>>,
    auditLog: { createCalls: 0, entries: [] as Array<Record<string, unknown>> },
    taskEvents: [] as Array<Record<string, unknown>>,
    toolEffects: new Map<string, Record<string, unknown>>(),
    ruleLog: [] as string[],
    setRules: (next: Array<Record<string, unknown>>) => {
      rules = next
    },
  }
  const approvalRequest = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const approval = {
        agentAccessCredentialId: null,
        continuationToken: 'token-1',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        resolution: null,
        resolutionNote: null,
        resolvedAt: null,
        resolverId: null,
        status: 'pending',
        updatedAt: new Date(),
        ...data,
        id: `approval-${state.approvalRequests.length + 1}`,
      }
      state.approvalRequests.push(approval)
      return approval
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      state.approvalRequests.find((approval) =>
        Object.entries(where).every(([key, value]) => approval[key] === value),
      ) ?? null,
    findMany: async () => [],
    updateMany: async () => ({ count: 1 }),
  }
  const prisma = {
    // The run's trigger answered no card, so it has no prepared call to run.
    agentCard: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRaw: async () => 1,
      approvalRequest,
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.auditLog.createCalls += 1
          state.auditLog.entries.push(data)
          return {}
        },
        findFirst: async () => null,
      },
    }),
    agent: { update: async () => ({}) },
    approvalRequest,
    userAlert: { createMany: async () => ({ count: 1 }) },
    policyRule: {
      findMany: async (query: { where: { scopeId: { in: string[] } } }) => {
        state.ruleLog.push(...query.where.scopeId.in)
        return rules.filter((rule) =>
          (query.where.scopeId.in as string[]).includes(rule['scopeId'] as string),
        )
      },
    },
    runBasisScope: { createMany: async () => ({ count: 1 }) },
    run: { findUnique: async () => null },
    // The tool-effect ledger claims every MCP and executor dispatch before it
    // runs (`tool-effect-ledger.ts`), so this fake has to model the table or
    // every such call here dies on an undefined delegate. Modelled rather than
    // stubbed: the ledger reads back what it wrote, and a `createMany` that
    // ignored `skipDuplicates` would silently turn a claim into a duplicate.
    runToolEffect: {
      createMany: async (
        { data }: { data: Array<{ runId: string; toolCallId: string }> },
      ) => {
        const rows = data.filter((row) => !state.toolEffects.has(effectKey(row)))
        for (const row of rows) state.toolEffects.set(effectKey(row), { ...row })
        return { count: rows.length }
      },
      deleteMany: async ({ where }: { where: { runId: string; toolCallId?: string } }) => {
        for (const [key, row] of [...state.toolEffects]) {
          if (row['runId'] !== where.runId) continue
          if (where.toolCallId && row['toolCallId'] !== where.toolCallId) continue
          state.toolEffects.delete(key)
        }
        return { count: 0 }
      },
      findUnique: async (
        { where }: { where: { runId_toolCallId: { runId: string; toolCallId: string } } },
      ) => state.toolEffects.get(effectKey(where.runId_toolCallId)) ?? null,
      updateMany: async (
        { data, where }: {
          data: Record<string, unknown>
          where: { runId: string; toolCallId: string }
        },
      ) => {
        const row = state.toolEffects.get(effectKey(where))
        if (!row) return { count: 0 }
        state.toolEffects.set(effectKey(where), { ...row, ...data })
        return { count: 1 }
      },
    },
    taskEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.taskEvents.push(data)
        return {}
      },
    },
    toolCall: {
      create: async () => ({ id: 'recorded-tool-call' }),
      updateMany: async () => ({ count: 1 }),
    },
  }
  return {
    ...state,
    prisma: prisma as unknown as ExecutionDependencies['prisma'],
  }
}

type PublishedWsEvent = { data: unknown; event: string }

const deps = (
  fake: FakePrisma,
  wsEvents: PublishedWsEvent[],
): ExecutionDependencies => ({
  modelClient: {} as ExecutionDependencies['modelClient'],
  prisma: fake.prisma,
  queueProvider: {} as ExecutionDependencies['queueProvider'],
  realtimeTransport: {
    publishSse: async () => undefined,
    publishWs: async (_scopes: unknown, event: PublishedWsEvent) => {
      wsEvents.push(event)
    },
  } as unknown as ExecutionDependencies['realtimeTransport'],
  searchConfig: {
    modelClient: {} as ExecutionDependencies['modelClient'],
    pool: {} as Pool,
  },
})

const quietGuard = () => ({
  bound: false,
  assertCompletion: () => undefined,
  dispatchDeepWater: async () => {
    throw new Error('not used')
  },
  markDelivered: () => undefined,
  suppressBuiltin: async () => false,
  timeoutErrorFor: () => null,
})

const makeInvocation = (): InvocationRecord => ({
  invocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  latencyMs: 1,
  model: 'gpt-5-mini',
  operationType: 'chat',
  provider: 'openai',
  requestId: 'req-1',
  usage: { totalTokens: 1 },
})

const toolCallTurn = (toolName: string, args: Record<string, unknown>): InferenceResult => ({
  finishReason: 'tool-call',
  invocations: [makeInvocation()],
  model: 'gpt-5-mini',
  outputText: '',
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [{ arguments: args, toolCallId: 'call-1', toolName }],
})

const finalTurn = (outputText = 'Done.'): InferenceResult => ({
  invocations: [makeInvocation()],
  model: 'gpt-5-mini',
  outputText,
  provider: 'openai',
  requestId: 'req-2',
  toolCalls: [],
})

type LoopHarness = {
  catalogRequests: string[]
  dispatchedMcp: string[]
  dispatchedExecutor: string[]
  executorTimeoutLookups: string[]
  fake: FakePrisma
  invocationSink: InvocationRecord[]
  // What the thought log was told about each call: [provider call id, ToolCall].
  linkedToolLines: Array<[string, string]>
  result: Awaited<ReturnType<typeof runExecutionAgentLoop>>
  wsEvents: PublishedWsEvent[]
  subAgentToolResults: Array<{ output: string; toolName: string }>
}

const runLoop = async (input: {
  allowBuiltinExec?: boolean
  builtinName?: string
  /** The toolset's first-class coding tools; their names join the executor names. */
  codingSessions?: NonNullable<ExecutorToolset['codingSessions']>
  mcpTools?: Record<string, AgenticToolResult>
  executorCatalog?: ExecutorMcpCatalogAnswer
  executorTools?: Record<string, AgenticToolResult>
  reviewer?: 'allow' | 'deny' | 'unavailable' | 'unparseable' | 'require_approval'
  restricted?: boolean
  privateConversation?: boolean
  resolvedBuiltinToolIds?: Set<string>
  rules?: Array<Record<string, unknown>>
  // Sequence of sub-agent turns used by the delegate path.
  subAgentTurns?: InferenceResult[]
  thinkingRecorder?: ThinkingRecorder
  toolName: string
  toolArgs?: Record<string, unknown>
}): Promise<LoopHarness> => {
  const fake = fakePrisma()
  const context = runContext()
  if (input.privateConversation) {
    context.consumedSources.addPrivateConversationSource({ sourceChannelId: CHANNEL_ID, sourceAuthorUserId: USER_ID })
  }
  const wsEvents: PublishedWsEvent[] = []
  if (input.restricted) {
    context.consumedSources.add({
      scopeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scopeType: 'user',
    })
  }
  if (input.rules) {
    fake.setRules(input.rules)
  }
  const dispatchedMcp: string[] = []
  const dispatchedExecutor: string[] = []
  const executorTimeoutLookups: string[] = []
  const catalogRequests: string[] = []
  const mcpEntries = input.mcpTools ?? {}
  const executorEntries = input.executorTools ?? {}

  const mcpToolset = {
    createView: () => ({
      descriptors: Object.keys(mcpEntries).map((name) => ({
        description: `${name} description`,
        inputSchema: { properties: {}, type: 'object' },
        toolName: name,
      })),
      dispatch: async (name: string) => {
        dispatchedMcp.push(name)
        return mcpEntries[name]
      },
      handledNames: new Set(Object.keys(mcpEntries)),
    }),
    timeoutErrorFor: () => null,
  } as unknown as McpToolset

  const executorToolset = {
    codingSessions: input.codingSessions ?? null,
    descriptors: [],
    dispatch: async (name: string) => {
      dispatchedExecutor.push(name)
      return executorEntries[name]
    },
    handledNames: new Set([
      ...Object.keys(executorEntries),
      ...(input.codingSessions?.descriptors ?? []).map((descriptor) => descriptor.toolName),
    ]),
    mcpCatalog: async (server: string) => {
      catalogRequests.push(server)
      return input.executorCatalog ?? { failure: { inputSummary: '', output: 'no catalog scripted', success: false } }
    },
    timeoutErrorFor: () => null,
    timeoutMsFor: (name: string) => {
      executorTimeoutLookups.push(name)
      return undefined
    },
  } as unknown as ExecutorToolset

  const builtinName = input.builtinName ?? 'kb_search'
  const linkedToolLines: Array<[string, string]> = []
  const subAgentToolResults: Array<{ output: string; toolName: string }> = []
  const invocationSink: InvocationRecord[] = []
  let mainTurn = 0
  let subTurn = 0
  const script = input.subAgentTurns ?? []
  const runUtility = async (
    messages: unknown,
    _tools: unknown,
    captured?: { toolResults?: Array<{ output: string; toolName: string }> },
  ): Promise<InferenceResult> => {
    const first = Array.isArray(messages) ? messages[0] : null
    if (first?.content?.startsWith('[nessie.follow_up_review.v1]\n')) {
      return finalTurn('{"needsFollowUp":false,"reason":"The scripted tool sequence is complete."}')
    }
    if (
      first
      && typeof first === 'object'
      && 'content' in first
      && typeof first.content === 'string'
      && first.content.includes("Nessie's action safety reviewer")
    ) {
      if (input.reviewer === 'unavailable') throw new Error('utility unavailable')
      const verdict = input.reviewer ?? 'allow'
      return finalTurn(
        verdict === 'unparseable'
          ? 'not valid reviewer output'
          : JSON.stringify({
            reason: verdict === 'deny' ? 'The destination is not authorized.' : 'Routine review.',
            verdict,
          }),
      )
    }
    if (captured?.toolResults) {
      subAgentToolResults.push(...captured.toolResults)
    }
    subTurn += 1
    return script[subTurn - 1] ?? finalTurn('sub-agent answer')
  }

  const result = await runExecutionAgentLoop(
    deps(fake, wsEvents),
    { actorContext: actorContext(), messageId: 'msg-1' } as never,
    context,
    {
      allowedToolIds: new Set([builtinName, 'delegate']),
      // Main-loop tool calls are exactly one per scenario (the gated tool, or
      // `delegate`); the loop reserves one slot, so the cap must leave room.
      budget: { maxIterations: 6, maxToolCalls: 4, maxWallclockMs: 10_000 },
      cacheReadWeight: 1,
      checkBudgetBlocked: async () => false,
      // Crash checkpoints are exercised in `worker/test/db/`; these cases are
      // about authorization, so the writer records nothing and says so (false:
      // nothing became durable).
      crashCheckpoint: { write: async () => false },
      deepWaterHandoffGuard: quietGuard(),
      executorToolset,
      identityToolIds: new Set<string>(),
      projectDelegatedToolIds: new Set<string>(),
      projectOperatorToolIds: new Set<string>(),
      liveRequester: true,
      initialMessages: [{ content: 'go', role: 'user' }],
      inference: {
        decide: null,
        consumeStreamedFlag: () => false,
        runMain: async () => {
          mainTurn += 1
          return mainTurn === 1
            ? toolCallTurn(input.toolName, input.toolArgs ?? {})
            : finalTurn()
        },
        runUtility,
      },
      isHandoffTurn: false,
      invocationSink,
      mcpToolset,
      resolvedToolIds: input.resolvedBuiltinToolIds ?? new Set([builtinName, 'delegate']),
      stubbedBuiltinToolIds: new Set(),
      thinkingRecorder: input.thinkingRecorder ?? {
        appendReasoning: async () => undefined,
        appendToolLine: async () => undefined,
        close: async () => undefined,
        linkToolCall: async (callId: string, toolCallId: string) => {
          linkedToolLines.push([callId, toolCallId])
        },
        replaceToolLine: async () => undefined,
      },
      toolDefs: [
        {
          description: 'builtin',
          inputSchema: { properties: {}, type: 'object' },
          toolName: builtinName,
        },
        {
          description: 'delegate',
          inputSchema: { properties: { task: { type: 'string' } }, type: 'object' },
          toolName: 'delegate',
        },
      ],
      toolSpecEnabled: false,
      toolPolicy: null,
      windDownInstruction: null,
    },
  )
  return {
    catalogRequests,
    dispatchedExecutor,
    dispatchedMcp,
    executorTimeoutLookups,
    fake,
    invocationSink,
    linkedToolLines,
    result,
    subAgentToolResults,
    wsEvents,
  }
}

test('restricted runs never publish tool input summaries', async () => {
  const privateCanary = 'private-tool-input-canary'
  const harness = await runLoop({
    restricted: true,
    toolArgs: { query: privateCanary },
    toolName: 'kb_search',
  })

  const toolStart = harness.wsEvents.find((event) => event.event === 'agent.tool.start')
  assert.deepEqual(toolStart?.data, {
    agentId: AGENT_ID,
    restricted: true,
    runId: RUN_ID,
  })
  assert.doesNotMatch(JSON.stringify(harness.wsEvents), new RegExp(privateCanary))
})

const denyRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: null,
  effect: 'deny',
  id: 'rule-deny',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})

const approvalRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: { approvalActionType: 'tool.invoke', requiresApproval: true },
  effect: 'allow',
  id: 'rule-approval',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})

const autoReviewRule = (toolId: string): Record<string, unknown> => ({
  action: 'invoke',
  bindings: [{ actorId: '*', actorType: 'user' }],
  conditions: { reviewMode: 'auto' },
  effect: 'allow',
  id: 'rule-auto-review',
  priority: 1,
  resourceType: 'tool',
  scope: 'tool',
  scopeId: toolId,
})

const reviewerInvocations = (invocations: InvocationRecord[]) => invocations.filter((invocation) => (
  invocation.metadata?.utilityPurpose === 'reviewer'
))

const parseDenied = (haystack: string, toolName: string): Record<string, unknown> => {
  const candidates = haystack.match(/\{[^{}]*"type":"tool_denied"[^{}]*\}/g) ?? []
  assert.ok(candidates.length > 0, `could not extract the tool_denied JSON payload from: ${haystack}`)
  const parsed = JSON.parse(candidates[0] as string) as Record<string, unknown>
  assert.equal(parsed['type'], 'tool_denied')
  assert.equal(parsed['toolId'], toolName)
  return parsed
}

// Main paths: the denial is the tool message in the main loop transcript.
const deniedOutput = (result: LoopHarness['result'], toolName: string): Record<string, unknown> => {
  const contents = result.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
  const haystack = contents.find((content) => content.includes('"type":"tool_denied"'))
  assert.ok(haystack, `expected a tool_denied result for ${toolName}; got: ${JSON.stringify(contents)}`)
  return parseDenied(haystack, toolName)
}

const suspendedApproval = (result: LoopHarness['result'], toolName: string): string => {
  assert.equal(result.pendingApproval?.toolName, toolName)
  assert.ok(result.pendingApproval?.approvalId)
  return result.pendingApproval.approvalId
}

// Delegated paths: the denial is the nested tool's result inside the
// sub-agent loop, captured via the DelegateRunner's out-param.
const delegatedDeniedOutput = (harness: LoopHarness, toolName: string): Record<string, unknown> => {
  const nested = harness.subAgentToolResults.find((entry) => entry.toolName === toolName)
  assert.ok(nested, `expected a nested tool result for ${toolName}; got: ${JSON.stringify(harness.subAgentToolResults)}`)
  return parseDenied(nested.output, toolName)
}

// --- main builtin ---

test('main builtin: a policy deny intercepts before dispatch and is audited', async () => {
  const harness = await runLoop({
    rules: [denyRule('kb_search')],
    toolName: 'kb_search',
  })
  const parsed = deniedOutput(harness.result, 'kb_search')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  assert.equal(parsed['policyRuleId'], 'rule-deny')
  assert.ok(harness.fake.ruleLog.includes('kb_search'))
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('main builtin: an approval-required allow suspends before dispatch', async () => {
  const harness = await runLoop({
    rules: [approvalRule('kb_search')],
    toolName: 'kb_search',
  })
  assert.equal(suspendedApproval(harness.result, 'kb_search'), 'approval-1')
  assert.equal(harness.fake.approvalRequests[0]?.['argsHash'] !== undefined, true)
  assert.equal(harness.fake.approvalRequests[0]?.['toolCallId'], 'call-1')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('a to-do-disabled agent is refused when it names todo_start directly', async () => {
  const harness = await runLoop({
    builtinName: 'todo_start',
    resolvedBuiltinToolIds: new Set(['delegate']),
    toolArgs: { todoId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    toolName: 'todo_start',
  })

  const parsed = deniedOutput(harness.result, 'todo_start')
  assert.equal(parsed['reason'], 'tool_not_granted')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

// --- main MCP ---

test('main MCP: a policy deny intercepts before dispatch and is audited', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [denyRule('mcp_fetch')],
    toolName: 'mcp_fetch',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = deniedOutput(harness.result, 'mcp_fetch')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('main MCP: an approval-required allow suspends before dispatch', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [approvalRule('mcp_fetch')],
    toolName: 'mcp_fetch',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  assert.equal(suspendedApproval(harness.result, 'mcp_fetch'), 'approval-1')
})

test('auto-review classifies only unsafe builtins, remote MCP calls, and executor actuation', () => {
  const mcpNames = new Set(['mcp_publish', 'mcp_find_tools', 'mcp_load_tools', 'mcp_drop_tools'])
  const executorNames = new Set([
    'executor_browser_act',
    'executor_browser_observe',
    'executor_command_run',
    'executor_file_read',
  ])

  for (const builtin of BUILTIN_TOOL_DEFINITIONS) {
    assert.equal(
      reviewableToolSurface(builtin.id, { executorToolNames: executorNames, mcpToolNames: mcpNames }),
      builtin.safe ? null : 'builtin',
      builtin.id,
    )
  }
  assert.equal(reviewableToolSurface('mcp_publish', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'mcp')
  assert.equal(reviewableToolSurface('mcp_find_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('mcp_load_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('mcp_drop_tools', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('executor_browser_act', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'executor')
  assert.equal(reviewableToolSurface('executor_command_run', { executorToolNames: executorNames, mcpToolNames: mcpNames }), 'executor')
  assert.equal(reviewableToolSurface('executor_browser_observe', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
  assert.equal(reviewableToolSurface('executor_file_read', { executorToolNames: executorNames, mcpToolNames: mcpNames }), null)
})

test('auto-review allows a live remote MCP call once and meters one utility invocation', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
    },
    reviewer: 'allow',
    rules: [autoReviewRule('mcp_publish')],
    toolArgs: { content: 'pošlete to prosím, je to fakt důležitý!' },
    toolName: 'mcp_publish',
  })

  assert.deepEqual(harness.dispatchedMcp, ['mcp_publish'])
  assert.equal(reviewerInvocations(harness.invocationSink).length, 1)
  assert.equal(harness.fake.approvalRequests.length, 0)
  assert.deepEqual(harness.fake.taskEvents, [{
    eventType: 'tool.auto_reviewed',
    payload: { surface: 'mcp', toolName: 'mcp_publish', verdict: 'allow' },
    taskId: TASK_ID,
  }])
  assert.ok(harness.fake.auditLog.entries.some((entry) => (
    (entry['metadata'] as { autoReview?: { verdict?: string } })?.autoReview?.verdict === 'allow'
  )))
})

test('auto-review denies a real MCP call without dispatching it', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
    },
    reviewer: 'deny',
    rules: [autoReviewRule('mcp_publish')],
    toolName: 'mcp_publish',
  })

  assert.deepEqual(harness.dispatchedMcp, [])
  assert.equal(deniedOutput(harness.result, 'mcp_publish')['reason'], 'auto_review_denied')
  assert.equal(reviewerInvocations(harness.invocationSink).length, 1)
  assert.equal(harness.fake.approvalRequests.length, 0)
})

for (const [reviewer, expectedReason] of [
  ['unavailable', 'The automated reviewer was unavailable, so a human must decide.'],
  ['unparseable', 'The automated reviewer could not produce a reliable decision.'],
] as const) {
  test(`auto-review ${reviewer} fails closed to an approval`, async () => {
    const harness = await runLoop({
      mcpTools: {
        mcp_publish: { inputSummary: 'publish', output: 'published', success: true },
      },
      reviewer,
      rules: [autoReviewRule('mcp_publish')],
      toolName: 'mcp_publish',
    })

    assert.deepEqual(harness.dispatchedMcp, [])
    assert.equal(suspendedApproval(harness.result, 'mcp_publish'), 'approval-1')
    assert.equal(
      harness.fake.approvalRequests[0]?.['reason'],
      `Automated review asked for approval before mcp_publish: ${expectedReason}`,
    )
  })
}

// --- main executor ---

for (const toolName of ['terminal_session_start', 'terminal_session_write', 'coding_session_close', 'executor_mcp_call']) {
  test(`private conversation does not veto authorized executor tool ${toolName}`, async () => {
    const harness = await runLoop({
      executorTools: { [toolName]: { inputSummary: 'authorized machine call', output: 'done', success: true } },
      privateConversation: true,
      toolName,
    })
    assert.deepEqual(harness.dispatchedExecutor, [toolName])
    assert.equal(harness.fake.approvalRequests.length, 0)
  })
}

test('private conversation still blocks a standalone MCP connector', async () => {
  const harness = await runLoop({
    mcpTools: { mcp_publish: { inputSummary: 'publish', output: 'done', success: true } },
    privateConversation: true,
    toolName: 'mcp_publish',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  assert.equal(deniedOutput(harness.result, 'mcp_publish')['reason'], 'private_conversation_disclosure_required')
})

test('main executor: a policy deny intercepts before dispatch and is audited', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor_file_read': { inputSummary: 'read', output: 'read', success: true },
    },
    rules: [denyRule('executor_file_read')],
    privateConversation: true,
    toolName: 'executor_file_read',
  })
  assert.deepEqual(harness.dispatchedExecutor, [])
  const parsed = deniedOutput(harness.result, 'executor_file_read')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  assert.ok(harness.fake.auditLog.createCalls > 0)
})

test('main executor: an approval-required allow suspends before dispatch', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor_file_read': { inputSummary: 'read', output: 'read', success: true },
    },
    rules: [approvalRule('executor_file_read')],
    toolName: 'executor_file_read',
  })
  assert.deepEqual(harness.dispatchedExecutor, [])
  assert.equal(suspendedApproval(harness.result, 'executor_file_read'), 'approval-1')
})

test('main executor: browser act writes a bounded audit-chain entry after dispatch', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor_browser_act': {
        inputSummary: 'click button',
        output: '{"status":"acted"}',
        success: true,
        toolCallRecordId: 'tool-call-1',
      },
    },
    toolArgs: { action: 'click', nodeId: 42, text: 'must not enter the audit chain' },
    toolName: 'executor_browser_act',
  })

  assert.ok(harness.dispatchedExecutor.length > 0)
  const entries = harness.fake.auditLog.entries.filter(
    (entry) => entry['action'] === 'executor.browser.action.dispatched',
  )
  assert.ok(entries.length > 0)
  assert.deepEqual(entries[0]?.['metadata'], {
    action: 'click',
    nodeId: 42,
    runId: RUN_ID,
    toolCallId: 'call-1',
  })
  assert.equal(entries[0]?.['resourceId'], 'tool-call-1')
})

test('main executor: command run audits only the argv program, never its arguments', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor_command_run': {
        inputSummary: 'run command',
        output: '{"exitCode":0}',
        success: true,
        toolCallRecordId: 'tool-call-2',
      },
    },
    toolArgs: { args: ['--token=not-for-audit'], program: 'tool' },
    toolName: 'executor_command_run',
  })

  const entries = harness.fake.auditLog.entries.filter(
    (entry) => entry['action'] === 'executor.command.run.dispatched',
  )
  assert.ok(entries.length > 0)
  assert.deepEqual(entries[0]?.['metadata'], {
    program: 'tool',
    runId: RUN_ID,
    toolCallId: 'call-1',
  })
})

test('main executor: an executor call is timed by the executor toolset', async () => {
  // The toolset answers with the command TTL plus a margin; without the
  // lookup the call would fall back to the ordinary timeout.
  const harness = await runLoop({
    executorTools: {
      'executor_mcp_call': { inputSummary: 'call', output: '{"success":true}', success: true },
    },
    toolArgs: { server: 'kelpie', tool: 'navigate' },
    toolName: 'executor_mcp_call',
  })
  assert.deepEqual(harness.dispatchedExecutor, ['executor_mcp_call'])
  assert.deepEqual(harness.executorTimeoutLookups, ['executor_mcp_call'])
})

// Meta's models call `default.<tool>` for a tool offered as `<tool>`. The main
// loop prepares every call before running it, so the preflight has to resolve
// the name as dispatch does — and so does the ledger's claim decision.
const namespacedExecutorCall = () => runLoop({
  executorTools: {
    'executor_mcp_call': { inputSummary: 'call', output: '{"success":true}', success: true },
  },
  toolArgs: { server: 'kelpie', tool: 'navigate' },
  toolName: 'default.executor_mcp_call',
})

test('main executor: a namespaced executor call is authorized and dispatched as the offered tool', async () => {
  const harness = await namespacedExecutorCall()
  const contents = harness.result.messages.map((message) =>
    (typeof message.content === 'string' ? message.content : ''))
  assert.ok(!contents.some((content) => content.includes('tool_denied')), JSON.stringify(contents))
  assert.deepEqual(harness.dispatchedExecutor, ['executor_mcp_call'])
})

test('main executor: a namespaced executor call is claimed in the tool-effect ledger before it runs', async () => {
  const harness = await namespacedExecutorCall()
  const claim = harness.fake.toolEffects.get(effectKey({ runId: RUN_ID, toolCallId: 'call-1' }))
  assert.ok(claim, 'an external dispatch under a provider prefix ran without a durable claim')
  assert.equal(claim['state'], 'completed')
})

test('main executor: a namespaced coding wait keeps rewriting the one thought-process line it opened', async () => {
  // Lines keyed as the recorder keys them, so the wait's rewrite lands only
  // on a line opened under the same name.
  const lines = new Map<string, string>()
  const thinkingRecorder: ThinkingRecorder = {
    appendReasoning: async () => undefined,
    appendToolLine: async (toolName, summary) => { lines.set(toolName, `${toolName}: ${summary}`) },
    close: async () => undefined,
    linkToolCall: async () => undefined,
    replaceToolLine: async (toolName, text) => {
      if (lines.has(toolName)) lines.set(toolName, `${toolName}: ${text}`)
    },
  }
  const waited: string[] = []
  const codingSessions: NonNullable<ExecutorToolset['codingSessions']> = {
    descriptors: [{ description: 'wait', inputSchema: { properties: {}, type: 'object' }, toolName: 'coding_session_wait' }],
    execute: async (toolName, _args, _callId, hooks) => {
      waited.push(toolName)
      await hooks?.onProgress?.('coding_session_wait', 'Claude Code: working — 14 steps (Bash 7, Edit 3)')
      return { inputSummary: 'wait', output: 'The turn ended.', success: true }
    },
    server: 'coding-sessions',
  }
  await runLoop({
    codingSessions,
    thinkingRecorder,
    toolArgs: { sessionId: 'a' },
    // Meta's models prefix the offered name.
    toolName: 'default.coding_session_wait',
  })
  assert.deepEqual(waited, ['coding_session_wait'])
  assert.deepEqual([...lines.entries()], [
    ['coding_session_wait', 'coding_session_wait: Claude Code: working — 14 steps (Bash 7, Edit 3)'],
  ], 'one line, under the offered name, and rewritten in place')
})

const toolMessage = (result: LoopHarness['result'], marker: string): string => {
  const contents = result.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  const found = contents.find((content) => content.includes(marker))
  assert.ok(found, `expected a tool result containing ${marker}; got: ${JSON.stringify(contents)}`)
  return found
}

test('main executor: an mcp.call answer reaches the model as the program’s output, not its envelope', async () => {
  const harness = await runLoop({
    executorTools: {
      'executor_mcp_call': {
        inputSummary: 'call',
        output: JSON.stringify({ content: [{ text: 'Page loaded: Example Domain', type: 'text' }], success: true }),
        success: true,
      },
    },
    toolArgs: { server: 'kelpie', tool: 'navigate' },
    toolName: 'executor_mcp_call',
  })
  const seen = toolMessage(harness.result, 'Page loaded: Example Domain')
  assert.match(seen, /Output of the program `kelpie` on the person's machine\./)
  assert.doesNotMatch(seen, /"content"/)
  assert.doesNotMatch(seen, /isolated browser/)
})

test('main executor: executor_mcp_tools answers from the run’s catalog and never dispatches the model’s arguments', async () => {
  const harness = await runLoop({
    executorCatalog: {
      server: 'kelpie',
      tools: [{ description: 'Open a URL. Then wait.', inputSchema: { type: 'object' }, name: 'navigate' }],
    },
    executorTools: {
      'executor_mcp_tools': { inputSummary: 'tools', output: 'dispatch must not run', success: true },
    },
    toolArgs: { server: 'kelpie' },
    toolName: 'executor_mcp_tools',
  })
  assert.deepEqual(harness.catalogRequests, ['kelpie'])
  assert.deepEqual(harness.dispatchedExecutor, [])
  const seen = toolMessage(harness.result, '- navigate: Open a URL.')
  assert.match(seen, /offers 1 tool\./)
})

// --- delegated paths: the model calls delegate; the sub-agent then calls the
// nested tool, whose authorization context is rebuilt for the nested name ---

test('delegated builtin: a policy deny intercepts the nested call before dispatch', async () => {
  const harness = await runLoop({
    rules: [denyRule('kb_search')],
    subAgentTurns: [
      toolCallTurn('kb_search', { query: 'secret' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'look something up' },
    toolName: 'delegate',
  })
  const parsed = delegatedDeniedOutput(harness, 'kb_search')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
  // The nested context must be the builtin's own name, not `delegate`.
  assert.ok(harness.fake.ruleLog.includes('kb_search'))
})

test('delegated builtin: an approval-required allow intercepts the nested call', async () => {
  const harness = await runLoop({
    rules: [approvalRule('kb_search')],
    subAgentTurns: [
      toolCallTurn('kb_search', { query: 'secret' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'look something up' },
    toolName: 'delegate',
  })
  const parsed = delegatedDeniedOutput(harness, 'kb_search')
  assert.equal(parsed['reason'], 'approval_required')
})

test('delegated MCP: a policy deny intercepts the nested call before dispatch', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [denyRule('mcp_fetch')],
    subAgentTurns: [
      toolCallTurn('mcp_fetch', { url: 'https://example.com' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'fetch a page' },
    toolName: 'delegate',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = delegatedDeniedOutput(harness, 'mcp_fetch')
  assert.equal(parsed['reason'], 'explicit_policy_deny')
})

test('delegated MCP: an approval-required allow intercepts the nested call', async () => {
  const harness = await runLoop({
    mcpTools: {
      mcp_fetch: { inputSummary: 'fetch', output: 'fetched', success: true },
    },
    rules: [approvalRule('mcp_fetch')],
    subAgentTurns: [
      toolCallTurn('mcp_fetch', { url: 'https://example.com' }),
      finalTurn('sub-agent answer'),
    ],
    toolArgs: { task: 'fetch a page' },
    toolName: 'delegate',
  })
  assert.deepEqual(harness.dispatchedMcp, [])
  const parsed = delegatedDeniedOutput(harness, 'mcp_fetch')
  assert.equal(parsed['reason'], 'approval_required')
})

// The thought log's line for a call names the ToolCall it became, which is how
// the thought-process dialog finds that call's screenshots.
test('a call\'s thought-log line is linked to the ToolCall it was recorded as', async () => {
  const builtin = await runLoop({ allowBuiltinExec: true, toolName: 'kb_search' })
  assert.deepEqual(builtin.linkedToolLines, [['call-1', 'recorded-tool-call']])

  const executor = await runLoop({
    executorTools: {
      'executor_mcp_call': {
        inputSummary: 'call',
        output: '{"success":true}',
        success: true,
        toolCallRecordId: 'executor-tool-call',
      },
    },
    toolArgs: { server: 'kelpie', tool: 'screenshot' },
    toolName: 'executor_mcp_call',
  })
  assert.deepEqual(executor.linkedToolLines, [['call-1', 'executor-tool-call']])
})
