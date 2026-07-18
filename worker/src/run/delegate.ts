import type {
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import { runAgenticLoop, type BudgetLimits } from './agentic-loop.js'
import type { McpToolset } from './mcp-toolset.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'

const SUB_AGENT_BUDGET: BudgetLimits = {
  maxIterations: 4,
  maxToolCalls: 6,
  maxWallclockMs: 60_000,
  maxTokens: 20_000,
  maxCostCents: 25,
  toolTimeoutMs: 25_000,
}

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused sub-agent dispatched by another agent to complete a single task using external tools (MCP).

Rules:
- Use the available tools to gather facts. Do not invent results.
- Be concise. Return a short, direct answer the parent can paste into a conversation.
- If a tool fails, try at most one alternative; otherwise report the failure plainly.
- Do not ask follow-up questions. Make the best decision with the information you have.
- You cannot delegate further. Stop when you have an answer or when no progress is possible.`

export type DelegateRunner = (
  messages: ProviderMessage[],
  tools: ToolSchemaDescriptor[],
) => Promise<InferenceResult>

export type DelegateExecuteContext = {
  mcpToolset: McpToolset
  /** Bound to call runInferenceGraph with sub-agent-specific tools each turn. */
  runInference: DelegateRunner
  /** Builtin tool executor for non-MCP tools (excluding `delegate` to prevent recursion). */
  executeBuiltinTool: (toolName: string, args: Record<string, unknown>) => Promise<AgenticToolResult>
  /** Builtin descriptors the sub-agent is allowed to call (already filtered to exclude `delegate`). */
  builtinDescriptors: ToolSchemaDescriptor[]
  /** Builtin tool IDs the sub-agent is allowed to call (excluding `delegate`). */
  allowedBuiltinIds: Set<string>
}

export type DelegateResult = AgenticToolResult & {
  invocations: InvocationRecord[]
  iterations: number
  toolCallsUsed: number
  exhaustedBudget: string | null
}

const buildInitialMessages = (task: string, hint: string | undefined): ProviderMessage[] => {
  const messages: ProviderMessage[] = [
    { role: 'system', content: SUB_AGENT_SYSTEM_PROMPT },
  ]
  const userParts = [`Task:\n${task}`]
  if (hint && hint.trim()) {
    userParts.push(`Hint: ${hint.trim()}`)
  }
  messages.push({ role: 'user', content: userParts.join('\n\n') })
  return messages
}

export const runDelegate = async (
  args: Record<string, unknown>,
  ctx: DelegateExecuteContext,
): Promise<DelegateResult> => {
  const task = typeof args['task'] === 'string' ? (args['task'] as string).trim() : ''
  const hintRaw = args['hint']
  const hint = typeof hintRaw === 'string' ? hintRaw.trim() : undefined
  const inputSummary = summarizeToolInput({ task: task.slice(0, 160), hint })

  if (!task) {
    return {
      inputSummary,
      output: 'delegate failed: "task" is required.',
      success: false,
      invocations: [],
      iterations: 0,
      toolCallsUsed: 0,
      exhaustedBudget: null,
    }
  }

  // Sub-agents get their own MCP view: in deferred mode they search/load
  // schemas independently without mutating the parent agent's tool list.
  const mcpView = ctx.mcpToolset.createView()
  const tools: ToolSchemaDescriptor[] = [
    ...mcpView.descriptors,
    ...ctx.builtinDescriptors,
  ]

  if (tools.length === 0) {
    return {
      inputSummary,
      output: 'delegate failed: no MCP or builtin tools available to the sub-agent.',
      success: false,
      invocations: [],
      iterations: 0,
      toolCallsUsed: 0,
      exhaustedBudget: null,
    }
  }

  const mcpExposedNames = mcpView.handledNames

  const loopResult = await runAgenticLoop({
    budget: SUB_AGENT_BUDGET,
    callbacks: {
      onIterationStart: async () => undefined,
      onToolCallStart: async () => undefined,
      onToolCallEnd: async () => undefined,
      onTextDelta: async () => undefined,
      onBudgetExhausted: async () => undefined,
    },
    executeTool: async (toolName, toolArgs, toolCallId) => {
      if (toolName === 'delegate') {
        return {
          inputSummary: summarizeToolInput(toolArgs),
          output: 'Nested delegation is not allowed inside a sub-agent.',
          success: false,
        }
      }
      if (mcpExposedNames.has(toolName)) {
        return mcpView.dispatch(toolName, toolArgs, toolCallId)
      }
      if (ctx.allowedBuiltinIds.has(toolName)) {
        return ctx.executeBuiltinTool(toolName, toolArgs)
      }
      return {
        inputSummary: summarizeToolInput(toolArgs),
        output: `Sub-agent attempted to call a tool not in its toolset: ${toolName}`,
        success: false,
      }
    },
    initialMessages: buildInitialMessages(task, hint),
    runInference: (messages) =>
      ctx.runInference(messages, [...mcpView.descriptors, ...ctx.builtinDescriptors]),
    tools,
  })

  const finalText = loopResult.finalText.trim()
  const success = !loopResult.exhaustedBudget && finalText.length > 0

  const output = finalText.length > 0
    ? finalText
    : `delegate exhausted budget (${loopResult.exhaustedBudget ?? 'unknown'}) without producing an answer.`

  return {
    inputSummary,
    output,
    success,
    invocations: loopResult.invocations,
    iterations: loopResult.iterations,
    toolCallsUsed: loopResult.toolCallsUsed,
    exhaustedBudget: loopResult.exhaustedBudget,
  }
}
