import assert from 'node:assert/strict'
import test from 'node:test'

import { type InferenceResult, type InvocationRecord } from '@nessie/runtime'
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
import type { ExecutorToolset } from '../executor-toolset.js'
import type { McpToolset } from '../mcp-toolset.js'
import type { AgenticToolResult } from '../tools.js'
import { approvalRule, denyRule } from './tool-authorization-test-fixtures.js'

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
export const RUN_ID = '66666666-6666-4666-8666-666666666666'
export const TASK_ID = '77777777-7777-4777-8777-777777777777'
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
}

const fakePrisma = (): FakePrisma => {
  let rules: Array<Record<string, unknown>> = []
  const state = {
    approvalRequests: [] as Array<Record<string, unknown>>,
    auditLog: { createCalls: 0, entries: [] as Array<Record<string, unknown>> },
    taskEvents: [] as Array<Record<string, unknown>>,
    ruleLog: [] as string[],
    setRules: (next: Array<Record<string, unknown>>) => {
      rules = next
    },
  }
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRaw: async () => 1,
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
    approvalRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const approval = { ...data, id: `approval-${state.approvalRequests.length + 1}` }
        state.approvalRequests.push(approval)
        return { id: approval.id }
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.approvalRequests.find((approval) =>
          Object.entries(where).every(([key, value]) => approval[key] === value),
        ) ?? null,
      updateMany: async () => ({ count: 1 }),
    },
    policyRule: {
      findMany: async (query: { where: { scopeId: { in: string[] } } }) => {
        state.ruleLog.push(...query.where.scopeId.in)
        return rules.filter((rule) =>
          (query.where.scopeId.in as string[]).includes(rule['scopeId'] as string),
        )
      },
    },
    run: { findUnique: async () => null },
    taskEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.taskEvents.push(data)
        return {}
      },
    },
    toolCall: {
      create: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
  }
  return {
    ...state,
    prisma: prisma as unknown as ExecutionDependencies['prisma'],
  }
}

const deps = (fake: FakePrisma): ExecutionDependencies => ({
  modelClient: {} as ExecutionDependencies['modelClient'],
  prisma: fake.prisma,
  queueProvider: {} as ExecutionDependencies['queueProvider'],
  realtimeTransport: {
    publishSse: async () => undefined,
    publishWs: async () => undefined,
  } as unknown as ExecutionDependencies['realtimeTransport'],
  searchConfig: {
    modelClient: {} as ExecutionDependencies['modelClient'],
    pool: {} as Pool,
  },
})

const quietGuard = () => ({
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

export const toolCallTurn = (toolName: string, args: Record<string, unknown>): InferenceResult => ({
  finishReason: 'tool-call',
  invocations: [makeInvocation()],
  model: 'gpt-5-mini',
  outputText: '',
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [{ arguments: args, toolCallId: 'call-1', toolName }],
})

export const finalTurn = (outputText = 'Done.'): InferenceResult => ({
  invocations: [makeInvocation()],
  model: 'gpt-5-mini',
  outputText,
  provider: 'openai',
  requestId: 'req-2',
  toolCalls: [],
})

type LoopHarness = {
  dispatchedMcp: string[]
  dispatchedExecutor: string[]
  fake: FakePrisma
  invocationSink: InvocationRecord[]
  result: Awaited<ReturnType<typeof runExecutionAgentLoop>>
  subAgentToolResults: Array<{ output: string; toolName: string }>
}

export const runLoop = async (input: {
  allowBuiltinExec?: boolean
  builtinName?: string
  mcpTools?: Record<string, AgenticToolResult>
  executorTools?: Record<string, AgenticToolResult>
  reviewer?: 'allow' | 'deny' | 'unavailable' | 'unparseable' | 'require_approval'
  resolvedBuiltinToolIds?: Set<string>
  rules?: Array<Record<string, unknown>>
  // Sequence of sub-agent turns used by the delegate path.
  subAgentTurns?: InferenceResult[]
  toolName: string
  toolArgs?: Record<string, unknown>
}): Promise<LoopHarness> => {
  const fake = fakePrisma()
  if (input.rules) {
    fake.setRules(input.rules)
  }
  const dispatchedMcp: string[] = []
  const dispatchedExecutor: string[] = []
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
    descriptors: [],
    dispatch: async (name: string) => {
      dispatchedExecutor.push(name)
      return executorEntries[name]
    },
    handledNames: new Set(Object.keys(executorEntries)),
  } as unknown as ExecutorToolset

  const builtinName = input.builtinName ?? 'kb_search'
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
    deps(fake),
    {
      actorContext: actorContext(),
      messageId: 'msg-1',
    } as never,
    runContext(),
    {
      allowedToolIds: new Set([builtinName, 'delegate']),
      // Main-loop tool calls are exactly one per scenario (the gated tool, or
      // `delegate`); the loop reserves one slot, so the cap must leave room.
      budget: { maxIterations: 6, maxToolCalls: 4, maxWallclockMs: 10_000 },
      cacheReadWeight: 1,
      checkBudgetBlocked: async () => false,
      deepWaterHandoffGuard: quietGuard(),
      executorToolset,
      identityToolIds: new Set<string>(),
      initialMessages: [{ content: 'go', role: 'user' }],
      inference: {
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
      thinkingRecorder: {
        appendReasoning: async () => undefined,
        appendWithheldMailReasoning: async () => undefined,
        appendToolLine: async () => undefined,
        close: async () => undefined,
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
    dispatchedExecutor,
    dispatchedMcp,
    fake,
    invocationSink,
    result,
    subAgentToolResults,
  }
}

export const reviewerInvocations = (invocations: InvocationRecord[]) => invocations.filter((invocation) => (
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
export const deniedOutput = (result: LoopHarness['result'], toolName: string): Record<string, unknown> => {
  const contents = result.messages
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
  const haystack = contents.find((content) => content.includes('"type":"tool_denied"'))
  assert.ok(haystack, `expected a tool_denied result for ${toolName}; got: ${JSON.stringify(contents)}`)
  return parseDenied(haystack, toolName)
}

export const suspendedApproval = (result: LoopHarness['result'], toolName: string): string => {
  assert.equal(result.pendingApproval?.toolName, toolName)
  assert.ok(result.pendingApproval?.approvalId)
  return result.pendingApproval.approvalId
}

// Delegated paths: the denial is the nested tool's result inside the
// sub-agent loop, captured via the DelegateRunner's out-param.
export const delegatedDeniedOutput = (harness: LoopHarness, toolName: string): Record<string, unknown> => {
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
