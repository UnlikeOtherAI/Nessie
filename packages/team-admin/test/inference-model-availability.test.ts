import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  isModelPairDisabled,
  loadDisabledModelPairs,
  loadDisabledTeamModelPairs,
  loadTeamModelAvailabilityDecisions,
  MODEL_PAIR_SEPARATOR,
  modelPairKey,
} from '../src/inference-model-availability.js'

/**
 * The exception list behind Admin › AI models.
 *
 * Two shapes are load-bearing and neither is obvious from the call sites: an
 * ABSENT row means available (so a model Ledger adds tomorrow is usable
 * tomorrow), and a half-empty pair is never "disabled" — a partial selection is
 * the Ledger validator's refusal to give, not this one's.
 */

const fakePrisma = (
  rows: { enabled: boolean; model: string; providerKey: string }[],
): { prisma: PrismaClient; seen: unknown[] } => {
  const seen: unknown[] = []
  const prisma = {
    inferenceModel: {
      findMany: async (args: unknown) => {
        seen.push(args)
        return rows
          .filter((row) => !row.enabled)
          .map((row) => ({ model: row.model, provider: { providerKey: row.providerKey } }))
      },
    },
  } as unknown as PrismaClient
  return { prisma, seen }
}

test('a pair key is provider and model, separated by a byte neither can contain', () => {
  assert.equal(modelPairKey('openai', 'gpt-5'), `openai${MODEL_PAIR_SEPARATOR}gpt-5`)
  // Without the NUL, ('a-b', 'c') and ('a', 'b-c') would collide on any
  // printable separator a Ledger service id or model name might itself use.
  assert.notEqual(modelPairKey('a-b', 'c'), modelPairKey('a', 'b-c'))
})

test('only an explicitly disabled row is loaded; everything else is available', async () => {
  const { prisma, seen } = fakePrisma([
    { enabled: false, model: 'deepseek-v4-flash', providerKey: 'deepseek' },
    { enabled: true, model: 'gpt-5-mini', providerKey: 'openai' },
  ])

  const disabled = await loadDisabledModelPairs(prisma, 'org-1')

  assert.deepEqual([...disabled], [modelPairKey('deepseek', 'deepseek-v4-flash')])
  assert.deepEqual(
    (seen[0] as { where: unknown }).where,
    { enabled: false, organizationId: 'org-1' },
    'the query is scoped to this organisation and to disabled rows only',
  )
})

test('a pair with no row at all is available — the list is exceptions, not an allow-list', () => {
  const disabled = new Set([modelPairKey('deepseek', 'deepseek-v4-flash')])

  assert.equal(isModelPairDisabled(disabled, 'deepseek', 'deepseek-v4-flash'), true)
  assert.equal(isModelPairDisabled(disabled, 'openai', 'gpt-5-mini'), false)
  // Same model id under a provider nobody switched off stays available.
  assert.equal(isModelPairDisabled(disabled, 'openai', 'deepseek-v4-flash'), false)
})

test('a half-empty selection is never reported as disabled', () => {
  const disabled = new Set([modelPairKey('deepseek', 'deepseek-v4-flash')])

  for (const [provider, model] of [
    [null, 'deepseek-v4-flash'],
    ['deepseek', null],
    [undefined, undefined],
    ['  ', 'deepseek-v4-flash'],
  ] as [string | null | undefined, string | null | undefined][]) {
    assert.equal(isModelPairDisabled(disabled, provider, model), false)
  }
})

test('surrounding whitespace on a stored selection does not smuggle a disabled pair through', () => {
  const disabled = new Set([modelPairKey('deepseek', 'deepseek-v4-flash')])

  assert.equal(isModelPairDisabled(disabled, ' deepseek ', ' deepseek-v4-flash '), true)
})

test('team decisions are scoped to one team and retain an explicit re-enable', async () => {
  const seen: unknown[] = []
  const prisma = {
    teamInferenceModelAvailability: {
      findMany: async (args: unknown) => {
        seen.push(args)
        const rows = [
          { enabled: false, model: 'gpt-5-mini', provider: 'openai' },
          { enabled: true, model: 'claude-sonnet', provider: 'anthropic' },
        ]
        const enabled = (args as { where: { enabled?: boolean } }).where.enabled
        return enabled === undefined ? rows : rows.filter((row) => row.enabled === enabled)
      },
    },
  } as unknown as PrismaClient

  const decisions = await loadTeamModelAvailabilityDecisions(prisma, 'team-1')
  const disabled = await loadDisabledTeamModelPairs(prisma, 'team-1')

  assert.equal(decisions.get(modelPairKey('openai', 'gpt-5-mini')), false)
  assert.equal(decisions.get(modelPairKey('anthropic', 'claude-sonnet')), true)
  assert.deepEqual([...disabled], [modelPairKey('openai', 'gpt-5-mini')])
  assert.deepEqual(
    (seen[0] as { where: unknown }).where,
    { teamId: 'team-1' },
    'decisions never bleed across UOA-backed teams',
  )
  assert.deepEqual(
    (seen[1] as { where: unknown }).where,
    { enabled: false, teamId: 'team-1' },
    'the picker and validator only load explicit team disables',
  )
})
