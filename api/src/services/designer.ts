import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  attributionFromActorContext,
  recordInferenceUsage,
  type LedgerInvocation,
  type ModelClient,
} from '@nessie/runtime'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import type { DesignerChatBodySchema } from '../contracts.js'

type DesignerChatInput = z.infer<typeof DesignerChatBodySchema>

type DesignerUsageContext = {
  actorContext: AuthorizedActionContext
  modelProvider: string
  prisma: PrismaClient
}

type DesignerUsageChunk = {
  completion_tokens: number
  prompt_tokens: number
  total_tokens?: number
}

const DESIGNER_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'set_name',
      description: 'Set the agent name',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_role',
      description: 'Set the agent role (e.g. assistant, reviewer, analyst, coder)',
      parameters: {
        type: 'object',
        properties: { role: { type: 'string' } },
        required: ['role'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_system_prompt',
      description:
        'Set or replace the agent system prompt.'
        + ' This is the main instruction text that defines agent behavior.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_provider',
      description: 'Set the LLM provider',
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['openai', 'anthropic', 'minimax', 'kimi', 'ollama', 'custom'],
          },
        },
        required: ['provider'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_model',
      description:
        'Set the LLM model name'
        + ' (e.g. gpt-5, gpt-5-mini, claude-sonnet-4-20250514)',
      parameters: {
        type: 'object',
        properties: { model: { type: 'string' } },
        required: ['model'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'toggle_tool',
      description: 'Enable or disable a tool for this agent',
      parameters: {
        type: 'object',
        properties: {
          toolId: {
            type: 'string',
            description:
              'Tool identifier — must be one of the ids in the'
              + ' "Available tools" list from the system prompt',
          },
          enabled: { type: 'boolean' },
        },
        required: ['toolId', 'enabled'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'batch_toggle_tools',
      description: 'Enable or disable multiple tools at once',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                toolId: { type: 'string' },
                enabled: { type: 'boolean' },
              },
              required: ['toolId', 'enabled'],
            },
          },
        },
        required: ['tools'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        'Search the web for information relevant to designing this agent.'
        + ' Use this to research topics, verify facts, or find domain'
        + ' knowledge before writing the system prompt.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
      },
    },
  },
]

const DESIGNER_MODEL = 'gpt-5-mini'
const MAX_TOOL_ROUNDS = 5

const buildAvailableToolLines = (
  availableTools: DesignerChatInput['availableTools'],
  formStateTools: Record<string, boolean>,
): string[] => {
  if (availableTools && availableTools.length > 0) {
    return availableTools.map((tool) => {
      const kind = tool.kind === 'mcp' ? ' [connector]' : ''
      const description = tool.description ? ` — ${tool.description.slice(0, 120)}` : ''
      return `- ${tool.id}${kind}: ${tool.label}${description}`
    })
  }

  const knownIds = Object.keys(formStateTools)
  return knownIds.length > 0 ? knownIds.map((id) => `- ${id}`) : ['(none registered)']
}

const buildSystemPrompt = (
  formState: DesignerChatInput['formState'],
  availableTools: DesignerChatInput['availableTools'],
): string => {
  const enabledTools = Object.entries(formState.tools)
    .filter(([, v]) => v)
    .map(([k]) => k)

  const summarizedSystemPrompt = formState.systemPrompt
    ? `"${formState.systemPrompt.slice(0, 200)}`
      + `${formState.systemPrompt.length > 200 ? '...' : ''}"`
    : '(empty)'

  return [
    'You are an expert AI agent designer.',
    'You help users create agents by configuring form fields via tool calls.',
    '',
    'Current form state:',
    `- Name: ${formState.name || '(empty)'}`,
    `- Role: ${formState.role || '(empty)'}`,
    `- System prompt: ${summarizedSystemPrompt}`,
    `- Provider: ${formState.provider}`,
    `- Model: ${formState.model}`,
    `- Tools enabled: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}`,
    '',
    'Available tools (use the exact id with toggle_tool / batch_toggle_tools):',
    ...buildAvailableToolLines(availableTools, formState.tools),
    '',
    '# Your principles',
    '',
    '1. START SIMPLE. Match the complexity of the system prompt to the task.',
    '   - A "name day checker" needs 3-5 lines, not 50.',
    '   - A code reviewer with linting rules needs more depth.',
    '   - Default to concise. Only add detail when the domain demands it.',
    '',
    '2. BE CONVERSATIONAL. You are a collaborator, not a form-filler.',
    '   - If the user says "make a bot that tells jokes" — set it up, done.',
    '   - If the user says "I need a medical triage assistant" — that\'s',
    '     complex. Suggest what you plan to include and ask if they want',
    '     to refine before you write it.',
    '',
    '3. DO NOT ASK UNNECESSARY QUESTIONS.',
    '   - If you can infer a reasonable answer, just do it.',
    '   - Only ask when the answer genuinely changes the output AND you',
    '     cannot infer it. One question max per turn, never a list.',
    '   - Never ask questions just to seem thorough.',
    '',
    '4. RESEARCH WHEN USEFUL. You have web_search.',
    '   - If the user asks for a domain-specific agent (Czech name days,',
    '     Japanese tax law, etc.), search first, then write a grounded',
    '     prompt based on real information.',
    '   - Do NOT search for generic topics you already know well.',
    '',
    '5. ITERATE. The first version does not need to be final.',
    '   - Set up a working agent quickly.',
    '   - The user can refine in follow-up messages.',
    '',
    '# Output rules',
    '',
    '- Use multiple tool calls in one response when setting several fields.',
    '- ALWAYS include a short text reply explaining what you did.',
    '  Never respond with only tool calls.',
    '- System prompts should be direct instructions to the agent.',
    '  No preamble, no meta-commentary. Write as if you ARE the system.',
  ].join('\n')
}

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
    await recordInferenceUsage(usageContext.prisma, {
      attribution: attributionFromActorContext(usageContext.actorContext),
      invocations: [
        {
          invocationId: randomUUID(),
          requestId: usageContext.actorContext.actionContext.requestId,
          correlationId:
            usageContext.actorContext.actionContext.correlationId,
          provider: usageContext.modelProvider,
          model: DESIGNER_MODEL,
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
  const response = await modelClient.fetchCompletion({
    model: DESIGNER_MODEL,
    messages,
    tools: DESIGNER_TOOLS,
    max_completion_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  })

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
              DESIGNER_MODEL,
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
    { role: 'system', content: buildSystemPrompt(input.formState, input.availableTools) },
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
