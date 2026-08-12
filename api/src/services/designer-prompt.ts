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
      name: 'set_model',
      description:
        'Set the model this agent runs on. Both fields come from one entry of'
        + ' the "Available models" list in the system prompt and must be'
        + ' copied verbatim — a pair outside that list cannot be saved.'
        + ' Pick one yourself: the list leads with the deployment\'s strongest'
        + ' model, so choose it unless the task calls for something cheaper or'
        + ' the user named a model. Never ask the user which model to use.',
      parameters: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description: 'The exact model id, e.g. gpt-5-mini',
          },
          provider: {
            type: 'string',
            description: 'The provider id listed beside that model id',
          },
        },
        required: ['model', 'provider'],
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

/**
 * `set_model` only lands if the pair it names is one the form can resolve
 * against the same catalogue, so the pair is what each line leads with; the
 * human-readable part follows for choosing between them. Order is the
 * catalogue's own — provider ascending, newest model of each provider first.
 */
export const buildAvailableModelLines = (
  availableModels: DesignerChatInput['availableModels'],
): string[] => {
  if (!availableModels || availableModels.length === 0) {
    return ['(catalogue unavailable — leave the model alone)']
  }

  return availableModels.map((option) => {
    const description = option.description
      ? ` — ${option.description.slice(0, 120)}`
      : ''
    return `- model=${option.model} provider=${option.provider}`
      + ` — ${option.displayName} (${option.providerDisplayName})${description}`
  })
}

export const buildDesignerSystemPrompt = (
  formState: DesignerChatInput['formState'],
  availableTools: DesignerChatInput['availableTools'],
  availableModels: DesignerChatInput['availableModels'],
): string => {
  const enabledTools = Object.entries(formState.tools)
    .filter(([, value]) => value)
    .map(([key]) => key)

  const currentModel = formState.model
    ? `${formState.model} (provider ${formState.provider || 'unset'})`
    : '(none selected — the agent cannot be saved without one)'

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
    `- Model: ${currentModel}`,
    `- Tools enabled: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}`,
    '',
    'Available tools (use the exact id with toggle_tool / batch_toggle_tools):',
    ...buildAvailableToolLines(availableTools, formState.tools),
    '',
    'Available models (use the exact model + provider pair with set_model):',
    ...buildAvailableModelLines(availableModels),
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
    '- A model is part of a working agent: if none is selected, call set_model',
    '  yourself. Leave an existing selection alone unless the user asks for a',
    '  different one.',
    '- ALWAYS include a short text reply explaining what you did.',
    '  Never respond with only tool calls.',
    '- System prompts should be direct instructions to the agent.',
    '  No preamble, no meta-commentary. Write as if you ARE the system.',
  ].join('\n')
}
