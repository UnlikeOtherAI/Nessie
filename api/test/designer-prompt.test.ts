import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentToolCatalog } from '@nessie/workspace-admin'

import {
  buildDesignerSystemPrompt,
  DESIGNER_TOOLS,
  type DesignerChatInput,
} from '../src/services/designer-prompt.js'

/**
 * The sidebar and the Agent Designer DM are one specialist (D9). These cases
 * pin the parts of that: the persona comes from the blueprint, the tool
 * catalogue from the server's own read of this organisation, and the closing
 * instruction tells the truth about *this* transport — a form nobody has saved.
 */

const organizationId = '00000000-0000-4000-8000-000000000001'

const formState = (
  overrides: Partial<DesignerChatInput['formState']> = {},
): DesignerChatInput['formState'] => ({
  name: 'Namesday',
  role: 'assistant',
  systemPrompt: '',
  provider: '',
  model: '',
  tools: {},
  ...overrides,
})

const models: DesignerChatInput['availableModels'] = [
  {
    provider: 'openai',
    providerDisplayName: 'OpenAI',
    model: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    description: 'Fast, cheap chat model.',
  },
  {
    provider: 'kimi',
    providerDisplayName: 'Kimi',
    model: 'kimi-k2',
    displayName: 'Kimi K2',
  },
]

const catalogue: AgentToolCatalog = {
  connectorCount: 1,
  restricted: [
    {
      allowMode: false,
      defaultEnabled: true,
      group: 'Agents & delegation',
      key: 'agent_create',
      kind: 'builtin',
      label: 'Create Agent',
      restriction: 'built_in_specialist_only',
      summary: 'Create a shared agent.',
    },
  ],
  togglable: [
    {
      allowMode: false,
      defaultEnabled: true,
      group: 'Web & research',
      key: 'web_search',
      kind: 'builtin',
      label: 'Web Search',
      summary: 'Search the public web.',
    },
  ],
}

const prompt = (
  overrides: Partial<Parameters<typeof buildDesignerSystemPrompt>[0]> = {},
): string =>
  buildDesignerSystemPrompt({
    availableModels: models,
    catalogue,
    formState: formState(),
    organizationId,
    webSearchAvailable: true,
    ...overrides,
  })

test('the persona is the blueprint\'s, not a second one written for the sidebar', () => {
  assert.match(prompt(), /You are the Agent Designer/)
  assert.match(prompt(), /Understand the work before you configure anything/)
})

test('the tool catalogue is the generated one, with policy keys', () => {
  const rendered = prompt()
  assert.match(rendered, /web_search \(Web Search\)/)
  assert.match(rendered, /on by default; set false to remove/)
  // A tool nobody may grant is named with its reason, never offered.
  assert.match(rendered, /agent_create — reserved for Nessie's built-in specialists/)
})

test('the model catalogue renders as exact provider/model pairs', () => {
  const rendered = prompt()
  assert.match(rendered, /openai\/gpt-5-mini — GPT-5 mini/)
  assert.match(rendered, /kimi\/kimi-k2 — Kimi K2/)
})

test('an unavailable catalogue tells the model to leave the field alone', () => {
  assert.match(prompt({ availableModels: [] }), /leave provider and model/i)
})

test('the prompt states the selected model so it is not reset needlessly', () => {
  const rendered = prompt({
    formState: formState({ model: 'kimi-k2', provider: 'kimi' }),
  })

  assert.match(rendered, /- Model: kimi-k2 \(provider kimi\)/)
})

test('an empty model reads as the blocker it is', () => {
  assert.match(prompt(), /- Model: \(none selected/)
})

test('the sidebar never claims it created an agent', () => {
  const rendered = prompt()
  assert.match(rendered, /filling in the form in front of the person/)
  assert.match(rendered, /never say an agent has been created or changed/)
})

test('an unconfigured web search is stated rather than silently missing', () => {
  assert.match(
    prompt({ webSearchAvailable: false }),
    /web_search is not configured on this deployment/,
  )
  assert.match(prompt({ webSearchAvailable: true }), /web_search is available/)
})

test('set_model is declared, and takes both fields together', () => {
  const setModel = DESIGNER_TOOLS.find(
    (tool) => tool.function.name === 'set_model',
  )

  assert.ok(setModel, 'the designer can set a model')
  assert.deepEqual(setModel.function.parameters['required'], [
    'model',
    'provider',
  ])
})

test('the current designer page limits the assistant to controls a person can reach', () => {
  const rendered = prompt({
    pageContext: {
      title: 'Tools',
      description: 'Review and change this agent’s tool access.',
      actions: ['enable or disable tools, then save the changes'],
    },
  })

  assert.match(rendered, /Current page:/)
  assert.match(rendered, /- Tools: Review and change this agent’s tool access\./)
  assert.match(
    rendered,
    /Controls available on this page: enable or disable tools, then save the changes/,
  )
  assert.match(
    rendered,
    /Only call a control-changing tool when[\s\S]*current page lists that/,
  )
})
