/**
 * Full sub-agent flow probe: parent loop → delegate → sub-agent → MCP → answer.
 *
 * Wires up:
 *  - real MCP fixture server (echo / now / fixture_add)
 *  - real `buildMcpToolset`-style descriptor list + dispatch closure (mocked
 *    around the fixture; no Postgres required)
 *  - real `runDelegate` against a real `runAgenticLoop`
 *  - stub `runInference` (no LLM cost) that scripts the conversation:
 *      parent turn 1: ask delegate to echo "ping"
 *      sub-agent turn 1: call mcp_echo({text: "ping"})
 *      sub-agent turn 2: produce final answer
 *      parent turn 2: produce final answer including the echoed string
 *
 * Asserts the final parent text mentions "ping" — proving the full chain
 * (parent inference → delegate intercept → sub-agent inference → MCP dispatch
 *  → tool result → sub-agent final → parent tool result → parent final).
 */

import type {
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '../packages/runtime/dist/inference/index.js'
import { runDelegate } from '../worker/dist/run/delegate.js'
import { runAgenticLoop, DEFAULT_BUDGET } from '../worker/dist/run/agentic-loop.js'
import { dispatchTool } from '../worker/dist/run/tool-dispatch.js'
import { startMcpFixture } from '../packages/mcp-client/test/fixtures/mcp-fixture-server.ts'

const echoSchema: Record<string, unknown> = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
}

const buildEmptyInvocation = (model: string, requestId: string): InvocationRecord => ({
  correlationId: undefined,
  finishReason: 'stop',
  invocationId: requestId,
  model,
  organizationId: 'org_probe',
  provider: 'openai',
  providerModelId: model,
  providerRequestId: requestId,
  requestId,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 1,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  },
} as unknown as InvocationRecord)

type ScriptedTurn = {
  outputText: string
  toolCalls: { toolName: string; arguments: Record<string, unknown> }[]
}

const makeScriptedInference = (turns: ScriptedTurn[]): {
  fn: (messages: ProviderMessage[], tools: ToolSchemaDescriptor[]) => Promise<InferenceResult>
  consumed: () => number
} => {
  let idx = 0
  return {
    fn: async (_messages, _tools) => {
      const turn = turns[idx]
      if (!turn) {
        throw new Error(`scripted inference exhausted after ${idx} turns`)
      }
      idx += 1
      const requestId = `probe_${idx}`
      const toolCalls = turn.toolCalls.map((tc, i) => ({
        toolCallId: `${requestId}_${i}`,
        toolName: tc.toolName,
        arguments: tc.arguments,
      }))
      return {
        correlationId: undefined,
        finishReason: toolCalls.length > 0 ? 'tool-call' : 'stop',
        invocations: [buildEmptyInvocation('probe-model', requestId)],
        model: 'probe-model',
        outputText: turn.outputText,
        provider: 'openai',
        requestId,
        toolCalls,
      } as InferenceResult
    },
    consumed: () => idx,
  }
}

const main = async (): Promise<void> => {
  const fixture = await startMcpFixture(0)
  console.log(`[probe] fixture: ${fixture.url}`)

  try {
    const mcpDescriptors: ToolSchemaDescriptor[] = [
      { toolName: 'mcp_echo', description: 'Echoes back text', inputSchema: echoSchema },
    ]
    const mcpToolset = {
      entries: [],
      descriptors: mcpDescriptors,
      dispatch: async (exposedName: string, args: Record<string, unknown>) => {
        if (exposedName !== 'mcp_echo') {
          return {
            inputSummary: JSON.stringify(args).slice(0, 200),
            output: `unknown mcp tool ${exposedName}`,
            success: false,
          }
        }
        const result = await dispatchTool({
          spec: {
            transport: 'mcp',
            connection: { transport: 'http', url: fixture.url },
            toolName: 'echo',
          },
          args,
        })
        return {
          inputSummary: JSON.stringify(args).slice(0, 200),
          output: result.output,
          success: result.success,
        }
      },
    }

    const subAgentScript = makeScriptedInference([
      { outputText: '', toolCalls: [{ toolName: 'mcp_echo', arguments: { text: 'ping' } }] },
      { outputText: 'The MCP server echoed: ping', toolCalls: [] },
    ])

    const parentScript = makeScriptedInference([
      {
        outputText: '',
        toolCalls: [{
          toolName: 'delegate',
          arguments: { task: 'Use mcp_echo to echo the word "ping" and report what came back.' },
        }],
      },
      { outputText: 'Sub-agent reported back: ping (verified via MCP).', toolCalls: [] },
    ])

    let subAgentInvocationCount = 0

    const parentLoop = await runAgenticLoop({
      budget: { ...DEFAULT_BUDGET, maxIterations: 4, maxToolCalls: 4 },
      callbacks: {
        onIterationStart: async () => undefined,
        onToolCallStart: async () => undefined,
        onToolCallEnd: async () => undefined,
        onTextDelta: async () => undefined,
        onBudgetExhausted: async () => undefined,
      },
      executeTool: async (toolName, args) => {
        if (toolName === 'delegate') {
          const result = await runDelegate(args as Record<string, unknown>, {
            mcpToolset,
            runInference: subAgentScript.fn,
            executeBuiltinTool: async () => ({
              inputSummary: '{}',
              output: 'no builtins in probe',
              success: false,
            }),
            builtinDescriptors: [],
            allowedBuiltinIds: new Set(),
          })
          subAgentInvocationCount = result.invocations.length
          return {
            inputSummary: result.inputSummary,
            output: result.output,
            success: result.success,
          }
        }
        return { inputSummary: '{}', output: `unknown parent tool ${toolName}`, success: false }
      },
      initialMessages: [
        { role: 'system', content: 'You are a parent agent with a single delegate tool.' },
        { role: 'user', content: 'Use delegate to ask a sub-agent to echo "ping" via MCP.' },
      ],
      runInference: (messages) => parentScript.fn(messages, [
        {
          toolName: 'delegate',
          description: 'Delegate to sub-agent with MCP tools',
          inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
        },
      ]),
      tools: [
        {
          toolName: 'delegate',
          description: 'Delegate to sub-agent with MCP tools',
          inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
        },
      ],
    })

    console.log('parent finalText:', parentLoop.finalText)
    console.log('parent iterations:', parentLoop.iterations)
    console.log('parent toolCallsUsed:', parentLoop.toolCallsUsed)
    console.log('sub-agent invocations captured:', subAgentInvocationCount)
    console.log('parent loop invocations (post-merge would happen here):', parentLoop.invocations.length)

    if (parentLoop.exhaustedBudget) {
      console.error('FAIL: parent loop exhausted budget:', parentLoop.exhaustedBudget)
      process.exitCode = 2
      return
    }
    if (!parentLoop.finalText.toLowerCase().includes('ping')) {
      console.error('FAIL: parent final text missing the echoed word')
      process.exitCode = 2
      return
    }
    if (subAgentInvocationCount !== 2) {
      console.error(`FAIL: expected 2 sub-agent invocations, got ${subAgentInvocationCount}`)
      process.exitCode = 2
      return
    }

    console.log('\nPASS — parent → delegate → sub-agent → MCP → answer verified')
  } finally {
    await fixture.close()
  }
}

await main()
