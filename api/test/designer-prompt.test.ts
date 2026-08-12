import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAvailableModelLines,
  buildDesignerSystemPrompt,
  DESIGNER_TOOLS,
  type DesignerChatInput,
} from '../src/services/designer-prompt.js'

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

test('each model line leads with the exact pair set_model has to copy', () => {
  assert.deepEqual(buildAvailableModelLines(models), [
    '- model=gpt-5-mini provider=openai — GPT-5 mini (OpenAI)'
    + ' — Fast, cheap chat model.',
    '- model=kimi-k2 provider=kimi — Kimi K2 (Kimi)',
  ])
})

test('an unavailable catalogue tells the model to leave the field alone', () => {
  assert.deepEqual(buildAvailableModelLines(undefined), [
    '(catalogue unavailable — leave the model alone)',
  ])
  assert.deepEqual(buildAvailableModelLines([]), [
    '(catalogue unavailable — leave the model alone)',
  ])
})

test('a long catalogue description is truncated, like a tool description', () => {
  const [line] = buildAvailableModelLines([
    { ...models[0]!, description: 'x'.repeat(200) },
  ])

  assert.ok(line?.endsWith(`— ${'x'.repeat(120)}`), line)
})

test('the prompt states the selected model so it is not reset needlessly', () => {
  const prompt = buildDesignerSystemPrompt(
    formState({ model: 'kimi-k2', provider: 'kimi' }),
    [],
    models,
  )

  assert.match(prompt, /- Model: kimi-k2 \(provider kimi\)/)
})

test('an empty model reads as the blocker it is', () => {
  const prompt = buildDesignerSystemPrompt(formState(), [], models)

  assert.match(prompt, /- Model: \(none selected/)
})

test('the catalogue reaches the prompt under the set_model heading', () => {
  const prompt = buildDesignerSystemPrompt(formState(), [], models)
  const heading = prompt.indexOf(
    'Available models (use the exact model + provider pair with set_model):',
  )

  assert.ok(heading > -1)
  assert.ok(prompt.indexOf('- model=gpt-5-mini provider=openai') > heading)
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
