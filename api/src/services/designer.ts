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
        'Set or replace the agent system prompt. This is the main instruction text that defines agent behavior. Be thorough.',
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
      description: 'Set the LLM model name (e.g. gpt-4o, gpt-4o-mini, claude-sonnet-4-20250514)',
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

const buildSystemPrompt = (formState: DesignerChatInput['formState']): string => {
  const enabledTools = Object.entries(formState.tools)
    .filter(([, v]) => v)
    .map(([k]) => k)

  return `You are an AI agent designer assistant. You help users configure AI agents by modifying their properties through tool calls.

Current form state:
- Name: ${formState.name || '(empty)'}
- Role: ${formState.role || '(empty)'}
- System prompt: ${formState.systemPrompt ? `"${formState.systemPrompt.slice(0, 200)}${formState.systemPrompt.length > 200 ? '...' : ''}"` : '(empty)'}
- Category: ${formState.categoryId || 'none'}
- Provider: ${formState.provider}
- Model: ${formState.model}
- Tools enabled: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}

Available tools the agent can be granted:
- System tools: bash, file-read, file-write, glob, grep, web-search

When the user describes what kind of agent they want, use your tools to configure the form fields. Write detailed system prompts that give the agent clear instructions. Always explain what you're changing and why.

When writing system prompts, be thorough: include the agent's purpose, constraints, tone, output format expectations, and domain-specific instructions. Aim for production quality.

Use multiple tool calls in a single response when configuring several fields at once.`
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
  apiKey: string | undefined,
): Promise<void> => {
  if (!apiKey) {
    reply.code(500).send({ error: 'OPENAI_API_KEY not configured' })
    return
  }

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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      messages,
      tools: DESIGNER_TOOLS,
      max_tokens: 4096,
      temperature: 0.7,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    writeSseEvent(reply, 'error', { message: `OpenAI error ${response.status}: ${errorText}` })
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
                tool_calls?: Array<{
                  function?: { arguments?: string; name?: string }
                  id?: string
                  index: number
                }>
              }
            }>
          }

          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue

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
