import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentModelOption } from '@nessie/schemas'
import {
  compareAgentModelOptions,
  compareModelLabels,
} from '@nessie/team-admin'

const order = (labels: string[]): string[] => [...labels].sort(compareModelLabels)

test('a higher version leads, including past a double-digit lexicographic trap', () => {
  assert.deepEqual(order(['GPT-4', 'GPT-10', 'GPT-5']), ['GPT-10', 'GPT-5', 'GPT-4'])
})

test('dotted versions compare segment by segment', () => {
  assert.deepEqual(
    order(['GPT-5', 'GPT-4.1', 'GPT-5.1', 'GPT-4']),
    ['GPT-5.1', 'GPT-5', 'GPT-4.1', 'GPT-4'],
  )
})

test('families stay alphabetical; only the version within a family is descending', () => {
  assert.deepEqual(
    order(['Claude Sonnet 5', 'Claude Opus 4.5', 'Claude Opus 5']),
    ['Claude Opus 5', 'Claude Opus 4.5', 'Claude Sonnet 5'],
  )
})

test('the base model precedes its variants of the same version', () => {
  assert.deepEqual(
    order(['GPT-5 mini', 'GPT-5', 'GPT-5 nano']),
    ['GPT-5', 'GPT-5 mini', 'GPT-5 nano'],
  )
})

test('unversioned names still sort alphabetically', () => {
  assert.deepEqual(order(['mistral-small', 'mistral-large']), ['mistral-large', 'mistral-small'])
})

test('options group by provider before newest-first within the provider', () => {
  const model = (provider: string, displayName: string): AgentModelOption => ({
    displayName,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    provider: provider.toLowerCase(),
    providerDisplayName: provider,
  })
  const options = [
    model('OpenAI', 'GPT-4.1'),
    model('Kimi', 'Kimi K2'),
    model('OpenAI', 'GPT-5'),
    model('Kimi', 'Kimi K2 Turbo'),
  ]

  assert.deepEqual(
    [...options].sort(compareAgentModelOptions).map((option) => option.displayName),
    ['Kimi K2', 'Kimi K2 Turbo', 'GPT-5', 'GPT-4.1'],
  )
})
