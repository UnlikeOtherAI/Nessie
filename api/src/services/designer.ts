import type { ModelClient } from '@nessie/runtime'
import type { FastifyReply } from 'fastify'
import type { z } from 'zod'
import type { DesignerChatBodySchema } from '../contracts.js'

type DesignerChatInput = z.infer<typeof DesignerChatBodySchema>

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
        + ' This is the main instruction text that defines agent behavior.'
        + ' Be thorough.',
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
      name: 'set_category',
      description: 'Assign the agent to a category by ID, or null to unassign',
      parameters: {
        type: 'object',
        properties: { categoryId: { type: ['string', 'null'] } },
        required: ['categoryId'],
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
            enum: ['openai', 'anthropic', 'minimax', 'ollama', 'custom'],
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
      description: 'Set the LLM model name (e.g. gpt-5, gpt-5-mini, claude-sonnet-4-20250514)',
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
              'Tool identifier: bash, file-read, file-write, glob, grep, web-search',
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
]

const DESIGNER_MODEL = 'gpt-5-mini'

const buildSystemPrompt = (formState: DesignerChatInput['formState']): string => {
  const enabledTools = Object.entries(formState.tools)
    .filter(([, v]) => v)
    .map(([k]) => k)

  const summarizedSystemPrompt = formState.systemPrompt
    ? `"${formState.systemPrompt.slice(0, 200)}${formState.systemPrompt.length > 200 ? '...' : ''}"`
    : '(empty)'

  return `You are an AI agent designer assistant.
You help users configure AI agents by modifying their properties through tool calls.

Current form state:
- Name: ${formState.name || '(empty)'}
- Role: ${formState.role || '(empty)'}
- System prompt: ${summarizedSystemPrompt}
- Category: ${formState.categoryId || 'none'}
- Provider: ${formState.provider}
- Model: ${formState.model}
- Tools enabled: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}

Available tools the agent can be granted:
- System tools: bash, file-read, file-write, glob, grep, web-search

When the user describes what kind of agent they want,
use your tools to configure the form fields,
then ALWAYS write a short conversational reply explaining what you set and why.
Never respond with tool calls only — every response must include text.

When writing system prompts, be thorough:
include the agent's purpose, constraints, tone,
output format expectations, and domain-specific instructions.
Aim for production quality.

Use multiple tool calls in a single response when configuring several fields at once.
After the tool calls, briefly summarise what you configured.`
}

type OpenAIMessage = {
  content: string | null
  role: 'assistant' | 'system' | 'user'
  tool_call_id?: string
}

const writeSseEvent = (reply: FastifyReply, event: string, data: unknown): void => {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export const streamDesignerChat = async (
  reply: FastifyReply,
  input: DesignerChatInput,
  modelClient: ModelClient,
): Promise<void> => {
  reply.raw.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  })

  const messages: OpenAIMessage[] = [
    { role: 'system', content: buildSystemPrompt(input.formState) },
    ...input.messages.map((m) => ({
      role: m.role as 'assistant' | 'user',
      content: m.content,
    })),
  ]

  let response: Response
  try {
    response = await modelClient.fetchCompletion({
      model: DESIGNER_MODEL,
      messages,
      tools: DESIGNER_TOOLS,
      max_completion_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Model request failed'
    writeSseEvent(reply, 'error', { message: msg })
    reply.raw.end()
    return
  }

  if (!response.body) {
    writeSseEvent(reply, 'error', { message: 'No response body' })
    reply.raw.end()
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // Track tool calls: index -> { id, name, argsBuffer }
  const toolCalls = new Map<number, { argsBuffer: string; id: string; name: string }>()

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
          // Finalize any open tool calls
          for (const [, tc] of toolCalls) {
            try {
              const args = JSON.parse(tc.argsBuffer) as Record<string, unknown>
              writeSseEvent(reply, 'tool_call.done', { id: tc.id, name: tc.name, args })
            } catch {
              writeSseEvent(reply, 'tool_call.done', {
                id: tc.id,
                name: tc.name,
                args: tc.argsBuffer,
              })
            }
          }
          writeSseEvent(reply, 'done', {})
          reply.raw.end()
          return
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
            usage?: {
              prompt_tokens: number
              completion_tokens: number
            }
          }

          // Capture usage from the final streaming chunk
          if (chunk.usage) {
            modelClient.usage.record(
              DESIGNER_MODEL,
              chunk.usage.prompt_tokens,
              chunk.usage.completion_tokens,
            )
          }

          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue

          // Reasoning content (model thinking)
          if (delta.reasoning_content) {
            writeSseEvent(reply, 'reasoning.delta', {
              content: delta.reasoning_content,
            })
          }

          // Text content
          if (delta.content) {
            writeSseEvent(reply, 'text.delta', { content: delta.content })
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              let existing = toolCalls.get(idx)

              if (tc.id && tc.function?.name) {
                // New tool call starting
                existing = { argsBuffer: '', id: tc.id, name: tc.function.name }
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

  // If we reach here without [DONE], still close
  for (const [, tc] of toolCalls) {
    try {
      const args = JSON.parse(tc.argsBuffer) as Record<string, unknown>
      writeSseEvent(reply, 'tool_call.done', { id: tc.id, name: tc.name, args })
    } catch {
      writeSseEvent(reply, 'tool_call.done', { id: tc.id, name: tc.name, args: tc.argsBuffer })
    }
  }
  writeSseEvent(reply, 'done', {})
  reply.raw.end()
}
