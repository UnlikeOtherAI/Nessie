import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterModelOptions,
  findModelOption,
  modelOptionLabel,
  modelOptionSubtitle,
} from '../src/components/features/agents/designer/model-options.js'

const option = (
  overrides: Partial<Parameters<typeof modelOptionLabel>[0]>,
): Parameters<typeof modelOptionLabel>[0] => ({
  displayName: 'GPT-5 mini',
  model: 'gpt-5-mini',
  provider: 'openai',
  providerDisplayName: 'OpenAI',
  ...overrides,
})

test('a query matches on display name, model id, provider or description', () => {
  const options = [
    option({}),
    option({ displayName: 'Kimi K2', model: 'kimi-k2', provider: 'kimi', providerDisplayName: 'Kimi' }),
  ]

  assert.deepEqual(filterModelOptions(options, 'kimi').map((o) => o.model), ['kimi-k2'])
  assert.deepEqual(filterModelOptions(options, 'openai').map((o) => o.model), ['gpt-5-mini'])
  assert.deepEqual(filterModelOptions(options, 'gpt-5').map((o) => o.model), ['gpt-5-mini'])
})

test('every term must match, in any order', () => {
  const options = [
    option({}),
    option({ displayName: 'GPT-5', model: 'gpt-5' }),
  ]

  assert.deepEqual(filterModelOptions(options, 'mini openai').map((o) => o.model), ['gpt-5-mini'])
  assert.deepEqual(filterModelOptions(options, 'openai mini').map((o) => o.model), ['gpt-5-mini'])
  assert.deepEqual(filterModelOptions(options, 'openai kimi'), [])
})

test('a blank query keeps the catalogue order untouched', () => {
  const options = [option({}), option({ displayName: 'GPT-5', model: 'gpt-5' })]

  assert.deepEqual(filterModelOptions(options, '   '), options)
})

test('the subtitle carries the model id and description, falling back to the provider', () => {
  assert.equal(
    modelOptionSubtitle(option({ description: 'Fast chat model.' })),
    'gpt-5-mini — Fast chat model.',
  )
  assert.equal(modelOptionSubtitle(option({})), 'gpt-5-mini')
  assert.equal(
    modelOptionSubtitle(option({ displayName: 'gpt-5-mini' })),
    'OpenAI',
  )
})

test('a model resolves only when its provider matches too', () => {
  const options = [
    option({}),
    option({ displayName: 'Kimi K2', model: 'kimi-k2', provider: 'kimi', providerDisplayName: 'Kimi' }),
  ]

  assert.equal(findModelOption(options, 'kimi-k2', 'kimi'), options[1])
  // The Design Assistant naming a real model against the wrong provider is
  // still an unsaveable pair, so it resolves to nothing.
  assert.equal(findModelOption(options, 'kimi-k2', 'openai'), undefined)
  assert.equal(findModelOption(options, 'gpt-6', 'openai'), undefined)
  assert.equal(findModelOption([], 'gpt-5-mini', 'openai'), undefined)
})

test('the field label repeats the model id only when it differs from the name', () => {
  assert.equal(modelOptionLabel(option({})), 'GPT-5 mini (gpt-5-mini)')
  assert.equal(modelOptionLabel(option({ displayName: 'gpt-5-mini' })), 'gpt-5-mini')
})
