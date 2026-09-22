import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  completeLedgerAttribution,
  CREDITS_EXHAUSTED_USER_MESSAGE,
  isCreditsExhaustedError,
  reasoningTextFromOpenAi,
  recordInferenceUsage,
  runWebSearch,
  WebSearchError,
  type LedgerIdentityService,
  type LedgerInvocation,
  type ModelClient,
} from '@nessie/runtime'
import {
  AGENT_DESIGNER_BLUEPRINT,
  loadAgentToolCatalog,
  resolveGlobalAgentModel,
} from '@nessie/team-admin'
import { listExecutorCatalogueFacts } from '@nessie/executor-manage'
import type { FastifyReply } from 'fastify'
import { isWebSearchConfigured } from './web-search.js'
import {
  buildDesignerSystemPrompt,
  DESIGNER_TOOLS,
  type DesignerChatInput,
} from './designer-prompt.js'

type DesignerUsageContext = {
  actorContext: AuthorizedActionContext
  /** Resolved once per request so usage records name the model actually called. */
  designerModel: string
  /** Signs `X-Nessie-Context` / `X-UOA-Delegation` on the Ledger search call. */
  ledgerIdentity: LedgerIdentityService | null
  modelProvider: string
  prisma: PrismaClient
}

type DesignerUsageChunk = {
  completion_tokens: number
  prompt_tokens: number
  total_tokens?: number
}

/**
 * The Designer's model, by the blueprint's own rule (D1/D9): a blueprint pin,
 * else `NESSIE_DESIGNER_MODEL`, else the organisation's default. One resolution
 * for both faces — the DM face reads it at bootstrap, this face at request
 * time — so the sidebar cannot quietly answer on a different model than the
 * chat.
 *
 * It used to be the literal `gpt-5-mini`, which is a guaranteed
 * `403 gpt-5-mini is not allowed for deepseek` on any deployment whose provider
 * is not OpenAI — the Design Assistant was dead on this one.
 */
export const resolveDesignerModel = (modelClient: ModelClient): string =>
  resolveGlobalAgentModel(AGENT_DESIGNER_BLUEPRINT).model ?? modelClient.chatModel
// Five independent draft fields plus a final prose turn. Tool choices are
// batched, so this is enough for a complete ordinary draft without an
// unbounded model conversation.
const MAX_TOOL_ROUNDS = 6
const DESIGNER_FORM_TOOLS = new Set([
  'set_name', 'set_role', 'set_system_prompt', 'set_model', 'set_tool_selection', 'toggle_tool', 'batch_toggle_tools',
])

const hasValidToolSelection = (
  argsBuffer: string,
  eligibleToolIds: ReadonlySet<string>,
): boolean => {
  try {
    const args = JSON.parse(argsBuffer) as { toolIds?: unknown }
    return Array.isArray(args.toolIds)
      && args.toolIds.every((toolId) => typeof toolId === 'string' && eligibleToolIds.has(toolId))
  } catch {
    return false
  }
}

export const userMessageForDesignerError = (error: unknown): string =>
  isCreditsExhaustedError(error)
    ? CREDITS_EXHAUSTED_USER_MESSAGE
    : 'The Design Assistant could not complete that request. Please try again.'

type OpenAIMessage = {
  content: string | null
  // The turn's reasoning, sent back under DeepSeek's field name so a provider
  // that refuses a tool round without it (DeepSeek) accepts the next request;
  // the connector strips it for providers that have no such field.
  reasoning_content?: string
  role: 'assistant' | 'system' | 'tool' | 'user'
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

const writeSseEvent = (
  reply: FastifyReply,
  event: string,
  data: unknown,
): void => {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * The sidebar's web search is the builtin's, not a second one.
 *
 * It used to scrape DuckDuckGo's HTML results page directly — a third-party
 * call with no Ledger provenance, predating and violating the Ledger-only rule
 * `AGENTS.md` states for `web_search`. It now runs the same `runWebSearch`
 * (moved into `@nessie/runtime` so both processes call one implementation),
 * against whichever Ledger search route the deployment configures, carrying
 * `LEDGER_PROXY_TOKEN` and the signed identity headers. A deployment without
 * Ledger degrades honestly: no results and a sentence saying why. There is
 * deliberately no scraping fallback.
 */

const WEB_SEARCH_UNAVAILABLE =
  'Web search is not configured on this deployment, so there are no results. '
  + 'Say so plainly rather than guessing.'

const executeWebSearch = async (
  query: string,
  usageContext: DesignerUsageContext,
  toolCallId: string,
): Promise<string> => {
  if (!isWebSearchConfigured(usageContext.ledgerIdentity)) {
    return WEB_SEARCH_UNAVAILABLE
  }
  try {
    const output = await runWebSearch(query, {
      attribution: completeLedgerAttribution(
        attributionFromActorContext(usageContext.actorContext, {
          systemComponent: 'designer',
        }),
      ),
      ledgerIdentity: usageContext.ledgerIdentity,
      toolCallId,
    })
    return output.text
  } catch (error) {
    if (error instanceof WebSearchError) {
      return `The web search for "${query}" failed just now, so there are no `
        + 'results. Say so rather than guessing.'
    }
    throw error
  }
}

const recordDesignerLedgerUsage = async (
  usageContext: DesignerUsageContext,
  usage: DesignerUsageChunk,
  latencyMs: number,
): Promise<void> => {
  const ledgerUsage: LedgerInvocation['usage'] = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
  }
  if (usage.total_tokens !== undefined) {
    ledgerUsage.totalTokens = usage.total_tokens
  }

  try {
    const attribution = completeLedgerAttribution(
      attributionFromActorContext(usageContext.actorContext, {
        systemComponent: 'designer',
      }),
    )
    await recordInferenceUsage(usageContext.prisma, {
      attribution,
      invocations: [
        {
          invocationId: randomUUID(),
          requestId: usageContext.actorContext.actionContext.requestId,
          correlationId:
            usageContext.actorContext.actionContext.correlationId,
          provider: usageContext.modelProvider,
          model: usageContext.designerModel,
          operationType: 'chat',
          usage: ledgerUsage,
          latencyMs,
        },
      ],
    })
  } catch {
    // Ledger capture is best-effort; keep the SSE response alive.
  }
}

type DesignerToolCall = { argsBuffer: string; id: string; name: string }

type DesignerTurn = {
  /** The reasoning the model showed, joined, for replay on the next round. */
  reasoning: string
  toolCalls: DesignerToolCall[]
}

/**
 * Stream a single model turn. Returns collected tool calls (if any)
 * so the caller can execute them and continue the loop.
 */
const streamModelTurn = async (
  reply: FastifyReply,
  messages: OpenAIMessage[],
  modelClient: ModelClient,
  usageContext: DesignerUsageContext,
): Promise<DesignerTurn> => {
  const startedAt = Date.now()
  const response = await modelClient.fetchCompletion(
    {
      model: resolveDesignerModel(modelClient),
      messages,
      tools: DESIGNER_TOOLS,
      max_completion_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
    },
    {
      usage: attributionFromActorContext(usageContext.actorContext, {
        systemComponent: 'designer',
      }),
    },
  )

  if (!response.body) {
    writeSseEvent(reply, 'error', { message: 'No response body' })
    return { reasoning: '', toolCalls: [] }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let reasoning = ''
  const toolCalls = new Map<number, DesignerToolCall>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          // Finalize open tool calls
          for (const [, tc] of toolCalls) {
            try {
              const args = JSON.parse(tc.argsBuffer) as Record<string, unknown>
              writeSseEvent(reply, 'tool_call.done', {
                id: tc.id,
                name: tc.name,
                args,
              })
            } catch {
              writeSseEvent(reply, 'tool_call.done', {
                id: tc.id,
                name: tc.name,
                args: tc.argsBuffer,
              })
            }
          }
          return { reasoning, toolCalls: Array.from(toolCalls.values()) }
        }

        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string | null
                reasoning?: string | null
                tool_calls?: Array<{
                  function?: { arguments?: string; name?: string }
                  id?: string
                  index: number
                }>
              }
            }>
            usage?: DesignerUsageChunk
          }

          if (chunk.usage) {
            modelClient.usage.record(
              usageContext.designerModel,
              chunk.usage.prompt_tokens,
              chunk.usage.completion_tokens,
            )
            await recordDesignerLedgerUsage(
              usageContext,
              chunk.usage,
              Date.now() - startedAt,
            )
          }

          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue

          const reasoningDelta = reasoningTextFromOpenAi(delta)
          if (reasoningDelta) {
            reasoning += reasoningDelta
            writeSseEvent(reply, 'reasoning.delta', { content: reasoningDelta })
          }

          if (delta.content) {
            writeSseEvent(reply, 'text.delta', { content: delta.content })
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              let existing = toolCalls.get(idx)

              if (tc.id && tc.function?.name) {
                existing = {
                  argsBuffer: '',
                  id: tc.id,
                  name: tc.function.name,
                }
                toolCalls.set(idx, existing)
                writeSseEvent(reply, 'tool_call.start', {
                  id: tc.id,
                  name: tc.function.name,
                })
              }

              if (tc.function?.arguments && existing) {
                existing.argsBuffer += tc.function.arguments
                writeSseEvent(reply, 'tool_call.delta', {
                  id: existing.id,
                  args: tc.function.arguments,
                })
              }
            }
          }
        } catch {
          // ignore malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { reasoning, toolCalls: Array.from(toolCalls.values()) }
}

export const streamDesignerChat = async (
  reply: FastifyReply,
  input: DesignerChatInput,
  modelClient: ModelClient,
  usageContext: DesignerUsageContext,
  corsHeaders: Record<string, string>,
): Promise<void> => {
  // The organisation's live tool catalogue, read here rather than trusted from
  // the browser: the two faces of the Designer must enumerate tools from one
  // source, and this is the member-safe projection `agent_tool_catalog` uses.
  // Read BEFORE the stream opens, so a database failure is an ordinary route
  // error rather than a half-written event stream.
  // The executors are read here for the same reason and in the same breath:
  // this face has no tools, so if the block does not carry them the Designer
  // cannot know a paired machine exists. Best-effort, exactly as the worker
  // face reads them — `null` is "could not be read", never "there are none".
  const [catalogue, executors] = await Promise.all([
    loadAgentToolCatalog(usageContext.prisma, {
      organizationId: usageContext.actorContext.tenant.organizationId,
    }),
    listExecutorCatalogueFacts(
      usageContext.prisma,
      usageContext.actorContext,
    ).catch(() => null),
  ])
  const eligibleToolIds = new Set(catalogue.togglable.map((tool) => tool.key))

  // Writing to reply.raw directly bypasses @fastify/cors, so the cross-origin
  // allow-origin header must be merged in here (computed by the route).
  reply.raw.writeHead(200, {
    ...corsHeaders,
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  })

  reply.raw.socket?.setNoDelay(true)

  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content: buildDesignerSystemPrompt({
        availableModels: input.availableModels,
        catalogue,
        executors,
        formState: input.formState,
        organizationId: usageContext.actorContext.tenant.organizationId,
        ...(input.pageContext ? { pageContext: input.pageContext } : {}),
        webSearchAvailable: isWebSearchConfigured(
          usageContext.ledgerIdentity,
        ),
      }),
    },
    ...input.messages.map((m) => ({
      role: m.role as 'assistant' | 'user',
      content: m.content,
    })),
  ]

  try {
    // Multi-turn loop: if the model calls web_search, execute it
    // and feed results back for another turn.
    let exhausted = true
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { reasoning, toolCalls } = await streamModelTurn(
        reply,
        messages,
        modelClient,
        usageContext,
      )

      // No tool calls — model is done
      if (toolCalls.length === 0) { exhausted = false; break }

      // Every recognised form update gets an acknowledgement and another
      // bounded turn. Sequential-tool models otherwise stop after `set_name`
      // and never reach role, prompt, or tool judgement. Unknown calls remain
      // terminal rather than being silently treated as designer actions.
      const needsContinuation = toolCalls.every((tc) =>
        (tc.name === 'web_search' || DESIGNER_FORM_TOOLS.has(tc.name))
        && (tc.name !== 'set_tool_selection' || hasValidToolSelection(tc.argsBuffer, eligibleToolIds)))
      if (!needsContinuation) { exhausted = false; break }

      // Build assistant message with all tool calls for conversation history
      const assistantToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsBuffer },
      }))
      messages.push({
        role: 'assistant',
        content: null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: assistantToolCalls,
      })

      // Execute web_search calls and add tool result messages
      for (const tc of toolCalls) {
        if (tc.name === 'web_search') {
          let query = ''
          try {
            const args = JSON.parse(tc.argsBuffer) as { query?: string }
            query = args.query ?? ''
          } catch {
            query = tc.argsBuffer
          }

          writeSseEvent(reply, 'status', {
            message: `Searching: ${query}`,
          })

          const results = await executeWebSearch(query, usageContext, tc.id)
          messages.push({
            role: 'tool',
            content: results,
            tool_call_id: tc.id,
          })
        } else {
          // Non-search tool calls get a simple ack so the model can continue
          messages.push({
            role: 'tool',
          content: DESIGNER_FORM_TOOLS.has(tc.name)
            ? 'Draft update was sent for review by the form.'
            : 'Done.',
            tool_call_id: tc.id,
          })
        }
      }

      // Signal that search is complete and model will continue
      writeSseEvent(reply, 'status', { message: 'Processing results...' })
    }
    if (exhausted) writeSseEvent(reply, 'status', {
      message: 'The draft has updates, but the assistant needs another message to finish explaining them.',
    })
  } catch (error) {
    writeSseEvent(reply, 'error', { message: userMessageForDesignerError(error) })
  }

  writeSseEvent(reply, 'done', {})
  reply.raw.end()
}
