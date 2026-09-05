import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AgentCardSpecSchema,
  CardPostToolInputSchema,
  AGENT_CARD_MAX_INPUT_CHARS,
  AGENT_CARD_MAX_EXPIRY_SECONDS,
  isAgentCardResponseMessage,
} from '../agent-card.js'
import { DashboardPresentationMessageMetadataSchema } from '../dashboard-presentation.js'

const baseSpec = {
  actions: [{ key: 'ok', label: 'OK', style: 'primary' as const, submits: true }],
  blocks: [{ markdown: 'Ship it?', type: 'text' as const }],
  schemaVersion: 1 as const,
  title: 'Deploy hotfix',
}

test('a minimal card is valid', () => {
  assert.equal(AgentCardSpecSchema.safeParse(baseSpec).success, true)
})

test('a dashboard-source secret is a closed credential destination', () => {
  const destination = {
    kind: 'dashboard_source_credential',
    mode: 'header',
    headerName: 'X-API-Key',
    sourceId: '22222222-2222-4222-8222-222222222222',
  }
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{ destination, key: 'api_key', label: 'API key', type: 'secret' }],
    }).success,
    true,
  )
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{
        destination: { ...destination, headerName: undefined },
        key: 'api_key',
        label: 'API key',
        type: 'secret',
      }],
    }).success,
    false,
  )
})

test('a dashboard presentation message contains only its stable pointer', () => {
  assert.equal(
    DashboardPresentationMessageMetadataSchema.safeParse({
      dashboardPresentation: {
        dashboardId: '33333333-3333-4333-8333-333333333333',
        schemaVersion: 1,
      },
    }).success,
    true,
  )
  assert.equal(
    DashboardPresentationMessageMetadataSchema.safeParse({
      dashboardPresentation: {
        dashboardId: '33333333-3333-4333-8333-333333333333',
        rows: [{ secret: 'never' }],
        schemaVersion: 1,
      },
    }).success,
    false,
  )
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

test('large input values require a per-card textarea bound', () => {
  const longDefault = 'x'.repeat(10_000)
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{
        default: longDefault,
        input: 'textarea',
        key: 'body',
        label: 'Message',
        maxLength: AGENT_CARD_MAX_INPUT_CHARS,
        type: 'input',
      }],
    }).success,
    true,
  )
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{
        input: 'textarea',
        key: 'body',
        label: 'Message',
        maxLength: AGENT_CARD_MAX_INPUT_CHARS + 1,
        type: 'input',
      }],
    }).success,
    false,
  )
  assert.equal(
    AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{
        input: 'select',
        key: 'choice',
        label: 'Choice',
        maxLength: 1_000,
        options: [{ label: 'One', value: 'one' }],
        type: 'input',
      }],
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

test('a card-press message is recognised structurally, and nothing else is', () => {
  const response = {
    agentCardResponse: {
      actionKey: 'allow',
      cardId: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
    },
  }
  assert.equal(isAgentCardResponseMessage(response), true)
  // A later key beside it must not make the press unrecognisable — the strict
  // whole-object schema would reject this, the predicate must not.
  assert.equal(isAgentCardResponseMessage({ ...response, mentions: ['x'] }), true)

  // The card message itself carries a different key and stays editable.
  assert.equal(
    isAgentCardResponseMessage({
      agentCard: { cardId: '11111111-1111-4111-8111-111111111111', schemaVersion: 1 },
    }),
    false,
  )
  for (const metadata of [undefined, null, {}, { agentCardResponse: null }]) {
    assert.equal(isAgentCardResponseMessage(metadata), false)
  }
  // Forged shapes are not presses: the key must carry a real card pointer.
  assert.equal(isAgentCardResponseMessage({ agentCardResponse: { cardId: 'nope' } }), false)
  assert.equal(isAgentCardResponseMessage({ agentCardResponse: true }), false)
})

test('a vault secret block carries the pre-filled name and defaults to personal scope', () => {
  const parsed = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    blocks: [{
      destination: { kind: 'vault_secret', name: 'STRIPE_API_KEY' },
      key: 'api_key',
      label: 'Stripe API key',
      type: 'secret',
    }],
  })

  assert.equal(parsed.success, true)
  const destination = parsed.success && parsed.data.blocks[0]?.type === 'secret'
    ? parsed.data.blocks[0].destination
    : null
  assert.equal(destination?.kind, 'vault_secret')
  assert.equal(destination?.kind === 'vault_secret' && destination.name, 'STRIPE_API_KEY')
  // Nothing wider than the presser's own scope unless the card asks for it.
  assert.equal(destination?.kind === 'vault_secret' && destination.scopeType, 'personal')
})

test('a vault secret name must survive the Secrets screen it will appear on', () => {
  for (const name of ['lowercase', '9LEADING_DIGIT', 'HAS SPACE', '']) {
    const parsed = AgentCardSpecSchema.safeParse({
      ...baseSpec,
      blocks: [{
        destination: { kind: 'vault_secret', name },
        key: 'api_key',
        label: 'API key',
        type: 'secret',
      }],
    })
    assert.equal(parsed.success, false, name)
  }
})

test('an agent names the message to scrub but never the text that replaces it', () => {
  const parsed = AgentCardSpecSchema.safeParse({
    ...baseSpec,
    blocks: [{
      destination: {
        kind: 'vault_secret',
        name: 'STRIPE_API_KEY',
        redactMessageId: '3f8a1c2e-9b7d-4e6f-a1b2-c3d4e5f6a7b8',
        replacementContent: 'anything',
      },
      key: 'api_key',
      label: 'API key',
      type: 'secret',
    }],
  })

  // `.strict()` is what keeps the replacement server-computed: an agent that
  // tries to supply the new wording is refused outright.
  assert.equal(parsed.success, false)
})
