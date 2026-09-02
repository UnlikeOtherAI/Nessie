import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AgentCardSpecSchema,
  CardPostToolInputSchema,
  AGENT_CARD_MAX_EXPIRY_SECONDS,
} from '../agent-card.js'

const baseSpec = {
  actions: [{ key: 'ok', label: 'OK', style: 'primary' as const, submits: true }],
  blocks: [{ markdown: 'Ship it?', type: 'text' as const }],
  schemaVersion: 1 as const,
  title: 'Deploy hotfix',
}

test('a minimal card is valid', () => {
  assert.equal(AgentCardSpecSchema.safeParse(baseSpec).success, true)
})

test('field keys must be unique across inputs and secrets', () => {
  const result = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    blocks: [
      { input: 'text', key: 'token', label: 'Token', type: 'input' },
      {
        destination: {
          instanceId: '11111111-1111-4111-8111-111111111111',
          kind: 'connector_credential',
        },
        key: 'token',
        label: 'Token',
        type: 'secret',
      },
    ],
  })
  assert.equal(result.success, false)
  assert.match(result.error?.issues[0]?.message ?? '', /unique/i)
})

test('action keys must be unique', () => {
  const result = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    actions: [
      { key: 'ok', label: 'OK', style: 'primary', submits: true },
      { key: 'ok', label: 'Fine', style: 'secondary', submits: true },
    ],
  })
  assert.equal(result.success, false)
})

test('a card with inputs needs a submitting action', () => {
  const result = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    actions: [{ key: 'cancel', label: 'Cancel', style: 'secondary', submits: false }],
    blocks: [{ input: 'text', key: 'note', label: 'Note', type: 'input' }],
  })
  assert.equal(result.success, false)
  assert.match(result.error?.issues[0]?.message ?? '', /submits/)
})

test('a select needs options and a non-select refuses them', () => {
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{ input: 'select', key: 'env', label: 'Environment', type: 'input' }],
    }).success,
    false,
  )
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [
        {
          input: 'text',
          key: 'env',
          label: 'Environment',
          options: [{ label: 'Prod', value: 'prod' }],
          type: 'input',
        },
      ],
    }).success,
    false,
  )
})

test('a card link must be https — never a plain-http beacon', () => {
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{ href: 'http://example.com', label: 'Open', type: 'link' }],
    }).success,
    false,
  )
})

test('an image is an attachment id, never a URL', () => {
  const result = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    blocks: [{ alt: 'A chart', type: 'image', url: 'https://example.com/a.png' }],
  })
  assert.equal(result.success, false)
})

test('the spec is strict: unknown keys are refused', () => {
  assert.equal(
    AgentCardSpecSchema.safeParse({ ...baseSpec, onPress: 'rm -rf /' }).success,
    false,
  )
})

test('expiry is bounded at both ends', () => {
  assert.equal(
    CardPostToolInputSchema.safeParse({ card: baseSpec, expiresIn: 30 }).success,
    false,
  )
  assert.equal(
    CardPostToolInputSchema.safeParse({
      card: baseSpec,
      expiresIn: AGENT_CARD_MAX_EXPIRY_SECONDS + 1,
    }).success,
    false,
  )
  assert.equal(
    CardPostToolInputSchema.safeParse({ card: baseSpec, expiresIn: 3600 }).success,
    true,
  )
})

test('respondents accept the three shapes and nothing else', () => {
  for (const respondents of [
    'requester',
    'thread',
    { userIds: ['11111111-1111-4111-8111-111111111111'] },
  ]) {
    assert.equal(
      CardPostToolInputSchema.safeParse({ card: baseSpec, respondents }).success,
      true,
    )
  }
  assert.equal(
    CardPostToolInputSchema.safeParse({ card: baseSpec, respondents: 'everyone' }).success,
    false,
  )
})
