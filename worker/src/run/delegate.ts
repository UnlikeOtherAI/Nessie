import type {
  InferenceResult,
  InvocationRecord,
  ProviderMessage,
  ToolSchemaDescriptor,
} from '@nessie/runtime'
import { runAgenticLoop } from './agentic-loop.js'
import { DELEGATE_BUDGET } from './run-budget.js'
import type { McpToolset } from './mcp-toolset.js'
import { summarizeToolInput } from './tool-util.js'
import type { AgenticToolResult } from './tools.js'
import type { ToolActorContext, ToolAuthorizationDecision } from './execute/tool-authorization.js'
import { AGENT_SECRET_SAFETY_INSTRUCTION } from './execute/prompt.js'

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused sub-agent dispatched by another agent to complete a single task using external tools (MCP).

Rules:
- Use the available tools to gather facts. Do not invent results.
- Be concise. Return a short, direct answer the parent can paste into a conversation.
- If a tool fails, try at most one alternative; otherwise report the failure plainly.
- Do not ask follow-up questions. Make the best decision with the information you have.
- ${AGENT_SECRET_SAFETY_INSTRUCTION}
- You cannot delegate further. Stop when you have an answer or when no progress is possible.`

export type DelegateToolResultCapture = {
  output: string
  success: boolean
  toolName: string
}

export type DelegateRunner = (
  messages: ProviderMessage[],
  tools: ToolSchemaDescriptor[],
  captured?: { toolResults: DelegateToolResultCapture[] },
) => Promise<InferenceResult>

export type DelegateExecuteContext = {
  mcpToolset: McpToolset
  /** The sub-agent's own MCP view, created by the caller. */
  mcpView: ReturnType<McpToolset['createView']>
  /** Bound to call runInferenceGraph with sub-agent-specific tools each turn. */
  runInference: DelegateRunner
  /**
   * The same pre-dispatch authorization gate the main loop runs, rebuilt for
   * the actual nested tool name: a sub-agent's builtin or MCP call is
   * authorized as itself, never under the outer `delegate` tool's context.
   */
  authorizeSubAgentTool: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolAuthorizationDecision>
  /** Builtin tool executor for non-MCP tools (excluding `delegate` to prevent recursion). */
  executeBuiltinTool: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
    toolActorContext: ToolActorContext,
    gmailDraftSendApproved?: true,
    gmailDraftSendStandingAuthorized?: true,
  ) => Promise<AgenticToolResult>
  /** Builtin descriptors the sub-agent is allowed to call (already filtered to exclude `delegate`). */
  builtinDescriptors: ToolSchemaDescriptor[]
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

  // The sub-agent gets its own MCP view (created by the caller): in deferred
  // mode it searches/loads schemas independently without mutating the parent
  // agent's tool list.
  const mcpView = ctx.mcpView
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
    budget: DELEGATE_BUDGET,
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
      // Gate before dispatch: the sub-agent's builtins and MCP calls pass the
      // same registry/policy/approval evaluation as the main loop, with the
      // authorization context rebuilt for this nested tool name.
      const authorization = await ctx.authorizeSubAgentTool(toolName, toolArgs)
      if (authorization.decision !== 'allow') {
        return authorization.decision === 'deny'
          ? authorization.result
          : {
            inputSummary: summarizeToolInput(toolArgs),
            output: 'This nested tool call requires approval from the main run.',
            success: false,
          }
      }
      if (mcpExposedNames.has(toolName)) {
        return mcpView.dispatch(toolName, toolArgs, toolCallId)
      }
      if (ctx.builtinDescriptors.some((descriptor) => descriptor.toolName === toolName)) {
        return ctx.executeBuiltinTool(
          toolName,
          toolArgs,
          toolCallId,
          authorization.toolActorContext,
          authorization.gmailDraftSendApproved,
          authorization.gmailDraftSendStandingAuthorized,
        )
      }
      return {
        inputSummary: summarizeToolInput(toolArgs),
        output: `Sub-agent attempted to call a tool not in its toolset: ${toolName}`,
        success: false,
      }
    },
    initialMessages: buildInitialMessages(task, hint),
    runInference: (messages, captured) =>
      ctx.runInference(
        messages,
        [...mcpView.descriptors, ...ctx.builtinDescriptors],
        captured && {
          toolResults: captured.toolResults.map((toolResult) => ({
            output: toolResult.output,
            success: toolResult.success,
            toolName: toolResult.toolName ?? '',
          })),
        },
      ),
    toolTimeoutError: ctx.mcpToolset.timeoutErrorFor,
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
