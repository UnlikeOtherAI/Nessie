import {
  AGENT_DESIGNER_BLUEPRINT,
  buildGlobalAgentCatalogueBlock,
  type AgentToolCatalog,
} from '@nessie/workspace-admin'
import type { z } from 'zod'

import type { DesignerChatBodySchema } from '../contracts.js'

/**
 * The Agent Designer's second face: the sidebar on the Agent Designer page.
 *
 * One brain, two doorways (D9). The persona and the generated capability
 * catalogue come from the blueprint module the DM face uses — this file adds
 * only what is genuinely different about *this transport*: the form is open in
 * front of the person, so the Designer changes it control-by-control with
 * `set_*` / `toggle_tool` instead of writing an agent, and nothing is saved
 * until the person saves it.
 *
 * What must never diverge is what the Designer knows and sounds like. The
 * hand-written "expert AI agent designer" persona and its numbered principles
 * that used to live here were a second definition of the same specialist, and
 * the tool list came from whatever the browser happened to send.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D9).
 */

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
        + ' the "Models available here" list in the system prompt and must be'
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
              'Tool policy key — must be one of the keys in the design'
              + ' catalogue from the system prompt',
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

export type DesignerPromptInput = {
  /** This organisation's live tool catalogue — the member-safe projection. */
  catalogue: AgentToolCatalog
  formState: DesignerChatInput['formState']
  availableModels: DesignerChatInput['availableModels']
  organizationId: string
  pageContext?: DesignerChatInput['pageContext']
  /** True when the deployment can actually reach the Ledger search route. */
  webSearchAvailable: boolean
}

export const buildDesignerSystemPrompt = (
  input: DesignerPromptInput,
): string => {
  const { formState } = input
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
    // The persona, from the blueprint. Identical wording to the DM face.
    AGENT_DESIGNER_BLUEPRINT.buildSystemPrompt({ organizationId: input.organizationId }),
    '',
    buildGlobalAgentCatalogueBlock({
      catalogue: input.catalogue,
      // The browser's own list, in the model picker's order: `set_model` only
      // lands if the pair it names is one the open form can resolve, and the
      // picker's order is what makes "the leading model" mean anything.
      models: input.availableModels ?? null,
      writeSurface: 'designer_form',
    }),
    '',
    'The form open in front of you right now:',
    `- Name: ${formState.name || '(empty)'}`,
    `- Role: ${formState.role || '(empty)'}`,
    `- System prompt: ${summarizedSystemPrompt}`,
    `- Model: ${currentModel}`,
    `- Tools enabled: ${enabledTools.length > 0 ? enabledTools.join(', ') : 'none'}`,
    '',
    'Current page:',
    `- ${input.pageContext?.title ?? 'Agent configuration'}: ${
      input.pageContext?.description ?? 'Edit this agent’s configuration.'}`,
    `- Controls available on this page: ${input.pageContext?.actions.join(', ') || 'none'}`,
    '',
    'How you work here:',
    '- You fill the form in: set_name, set_role, set_system_prompt, set_model,',
    '  toggle_tool and batch_toggle_tools each change one control the person is',
    '  looking at. Use several in one response when you are setting several',
    '  fields.',
    '- A model is part of a working agent: if none is selected, call set_model',
    '  yourself. Leave an existing selection alone unless the user asks for a',
    '  different one.',
    '- Always include a short text reply saying what you changed. Never respond',
    '  with only tool calls.',
    '- Only call a control-changing tool when the current page lists that',
    '  control as available; otherwise discuss the page directly.',
    '- A system prompt is direct instruction to the agent. No preamble, no',
    '  meta-commentary — write as if you ARE the system.',
    input.webSearchAvailable
      ? '- web_search is available for grounding a domain you do not know well.'
        + ' Do not search for generic topics you already know.'
      : '- web_search is not configured on this deployment. Say so if research'
        + ' would have helped, and never invent results.',
    '- The person can move this conversation into a full chat with you at any',
    '  time with "Continue in chat", which carries the current draft over.',
  ].join('\n')
}
