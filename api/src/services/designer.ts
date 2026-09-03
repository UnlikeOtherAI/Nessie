import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  CREDITS_EXHAUSTED_USER_MESSAGE,
  completeLedgerAttribution,
  isCreditsExhaustedError,
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
import type { FastifyReply } from 'fastify'
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
const MAX_TOOL_ROUNDS = 5

export const userMessageForDesignerError = (error: unknown): string =>
  isCreditsExhaustedError(error)
    ? CREDITS_EXHAUSTED_USER_MESSAGE
    : 'The Design Assistant could not complete that request. Please try again.'

type OpenAIMessage = {
  content: string | null
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
 * `AGENTS.md` states for `web_search`. It now posts to the same
 * `${LEDGER_PUBLIC_URL}/v1/serper/search` route the builtin does, through the
 * same `runWebSearch` (moved into `@nessie/runtime` so both processes call one
 * implementation), carrying `LEDGER_PROXY_TOKEN` and the signed identity
 * headers. A deployment without Ledger degrades honestly: no results and a
 * sentence saying why. There is deliberately no scraping fallback.
 */
export const isDesignerWebSearchConfigured = (
  ledgerIdentity: LedgerIdentityService | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  Boolean(env.LEDGER_PUBLIC_URL?.trim())
  && Boolean(env.LEDGER_PROXY_TOKEN?.trim())
  && ledgerIdentity !== null

const WEB_SEARCH_UNAVAILABLE =
  'Web search is not configured on this deployment, so there are no results. '
  + 'Say so plainly rather than guessing.'

const executeWebSearch = async (
  query: string,
  usageContext: DesignerUsageContext,
  toolCallId: string,
): Promise<string> => {
  if (!isDesignerWebSearchConfigured(usageContext.ledgerIdentity)) {
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

/**
 * Stream a single model turn. Returns collected tool calls (if any)
 * so the caller can execute them and continue the loop.
 */
const streamModelTurn = async (
  reply: FastifyReply,
  messages: OpenAIMessage[],
  modelClient: ModelClient,
  usageContext: DesignerUsageContext,
): Promise<Array<{ argsBuffer: string; id: string; name: string }>> => {
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
    return []
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const toolCalls = new Map<
    number,
    { argsBuffer: string; id: string; name: string }
  >()

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
          return Array.from(toolCalls.values())
        }

        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
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

          if (delta.reasoning_content) {
            writeSseEvent(reply, 'reasoning.delta', {
              content: delta.reasoning_content,
            })
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

  return Array.from(toolCalls.values())
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
  const catalogue = await loadAgentToolCatalog(usageContext.prisma, {
    organizationId: usageContext.actorContext.tenant.organizationId,
  })

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
        formState: input.formState,
        organizationId: usageContext.actorContext.tenant.organizationId,
        ...(input.pageContext ? { pageContext: input.pageContext } : {}),
        webSearchAvailable: isDesignerWebSearchConfigured(
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
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const toolCalls = await streamModelTurn(
        reply,
        messages,
        modelClient,
        usageContext,
      )

      // No tool calls — model is done
      if (toolCalls.length === 0) break

      // Check if any tool call needs backend execution (web_search)
      const needsContinuation = toolCalls.some(
        (tc) => tc.name === 'web_search',
      )

      if (!needsContinuation) break

      // Build assistant message with all tool calls for conversation history
      const assistantToolCalls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.argsBuffer },
      }))
      messages.push({
        role: 'assistant',
        content: null,
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
            content: 'Done.',
            tool_call_id: tc.id,
          })
        }
      }

      // Signal that search is complete and model will continue
      writeSseEvent(reply, 'status', { message: 'Processing results...' })
    }
  } catch (error) {
    writeSseEvent(reply, 'error', { message: userMessageForDesignerError(error) })
  }

  writeSseEvent(reply, 'done', {})
  reply.raw.end()
}
