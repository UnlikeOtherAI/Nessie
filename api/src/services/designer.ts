import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  completeLedgerAttribution,
  recordInferenceUsage,
  type LedgerInvocation,
  type ModelClient,
} from '@nessie/runtime'
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
  modelProvider: string
  prisma: PrismaClient
}

type DesignerUsageChunk = {
  completion_tokens: number
  prompt_tokens: number
  total_tokens?: number
}

/**
 * The designer's model.
 *
 * `NESSIE_DESIGNER_MODEL` names a cheaper one where the deployment has a
 * choice; otherwise it uses whatever chat model the deployment is configured
 * with. It used to be the literal `gpt-5-mini`, which is a guaranteed
 * `403 gpt-5-mini is not allowed for deepseek` on any deployment whose
 * provider is not OpenAI — the Design Assistant was dead on this one.
 */
const resolveDesignerModel = (modelClient: ModelClient): string =>
  process.env['NESSIE_DESIGNER_MODEL']?.trim() || modelClient.chatModel
const MAX_TOOL_ROUNDS = 5

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

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

const executeWebSearch = async (query: string): Promise<string> => {
  const searchUrl
    = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(searchUrl, {
    headers: { 'user-agent': 'NessieDesigner/1.0' },
  })
  const html = await response.text()
  const matches = Array.from(
    html.matchAll(
      /result__a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?result__snippet[^>]*>(.*?)<\/a/g,
    ),
  ).slice(0, 5)

  if (matches.length === 0) {
    return `No results found for "${query}".`
  }

  return matches
    .map((m, i) => {
      const title = stripHtml(m[2] ?? 'Result')
      const snippet = stripHtml(m[3] ?? '')
      return `${i + 1}. ${title}\n   ${snippet}`
    })
    .join('\n\n')
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
      content: buildDesignerSystemPrompt(input.formState, input.availableTools),
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

          const results = await executeWebSearch(query)
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
    const msg = error instanceof Error
      ? error.message
      : 'Model request failed'
    writeSseEvent(reply, 'error', { message: msg })
  }

  writeSseEvent(reply, 'done', {})
  reply.raw.end()
}
