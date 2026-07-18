import type { z } from 'zod'

import type { DesignerChatBodySchema } from '../contracts.js'

export type DesignerChatInput = z.infer<typeof DesignerChatBodySchema>

export const DESIGNER_TOOLS = [
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

export const buildDesignerSystemPrompt = (
  formState: DesignerChatInput['formState'],
  availableTools: DesignerChatInput['availableTools'],
): string => {
  const enabledTools = Object.entries(formState.tools)
    .filter(([, value]) => value)
    .map(([key]) => key)

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
