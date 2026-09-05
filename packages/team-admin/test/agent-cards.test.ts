import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AgentCardSpec } from '@nessie/schemas'

import {
  AgentCardValueError,
  validateAgentCardSubmission,
} from '../src/agent-card-values.js'
import {
  buildAgentCardStateNote,
  inheritAgentCardResponseBasis,
  renderAgentCardPlainText,
  renderAgentCardResponseText,
  presentAgentCardBlocks,
} from '../src/agent-card-presentation.js'

const INSTANCE = '11111111-1111-4111-8111-111111111111'

const formSpec: AgentCardSpec = {
  actions: [
    { key: 'send', label: 'Send', style: 'primary', submits: true },
    { key: 'cancel', label: 'Cancel', style: 'secondary', submits: false },
  ],
  blocks: [
    { markdown: 'Deploy?', type: 'text' },
    {
      input: 'select',
      key: 'environment',
      label: 'Environment',
      options: [{ label: 'Production', value: 'prod' }],
      required: true,
      type: 'input',
    },
    { input: 'text', key: 'note', label: 'Note', type: 'input' },
    {
      destination: { instanceId: INSTANCE, kind: 'connector_credential' },
      key: 'api_key',
      label: 'API key',
      type: 'secret',
    },
  ],
  schemaVersion: 1,
  title: 'Deploy hotfix',
}

test('a submitting press validates and returns the values', () => {
  const result = validateAgentCardSubmission({
    actionKey: 'send',
    secrets: { api_key: 'sk-live-123' },
    spec: formSpec,
    values: { environment: 'prod', note: 'ship it' },
  })
  assert.deepEqual(result.values, { environment: 'prod', note: 'ship it' })
  assert.deepEqual(Object.keys(result.secrets), ['api_key'])
})

test('a dismissing press ignores inputs entirely, so a half-filled form can be cancelled', () => {
  const result = validateAgentCardSubmission({
    actionKey: 'cancel',
    secrets: {},
    spec: formSpec,
    values: {},
  })
  assert.deepEqual(result.values, {})
  assert.deepEqual(result.secrets, {})
})

test('a required field and a declared secret must both be supplied', () => {
  assert.throws(
    () =>
      validateAgentCardSubmission({
        actionKey: 'send',
        secrets: { api_key: 'sk' },
        spec: formSpec,
        values: {},
      }),
    (error: unknown) =>
      error instanceof AgentCardValueError && error.fieldKeys.includes('environment'),
  )
  assert.throws(
    () =>
      validateAgentCardSubmission({
        actionKey: 'send',
        secrets: {},
        spec: formSpec,
        values: { environment: 'prod' },
      }),
    (error: unknown) =>
      error instanceof AgentCardValueError && error.fieldKeys.includes('api_key'),
  )
})

test('a select refuses a value that was never offered', () => {
  assert.throws(
    () =>
      validateAgentCardSubmission({
        actionKey: 'send',
        secrets: { api_key: 'sk' },
        spec: formSpec,
        values: { environment: 'staging' },
      }),
    AgentCardValueError,
  )
})

test('a field the card never declared is refused, not silently stored', () => {
  assert.throws(
    () =>
      validateAgentCardSubmission({
        actionKey: 'send',
        secrets: { api_key: 'sk' },
        spec: formSpec,
        values: { environment: 'prod', isAdmin: true },
      }),
    (error: unknown) =>
      error instanceof AgentCardValueError && error.fieldKeys.includes('isAdmin'),
  )
})

test('a button that is not on the card is refused', () => {
  assert.throws(
    () =>
      validateAgentCardSubmission({
        actionKey: 'approve_everything',
        secrets: {},
        spec: formSpec,
        values: {},
      }),
    AgentCardValueError,
  )
})

test('a card-declared textarea bound accepts email-sized copy without widening normal inputs', () => {
  const emailBody = 'x'.repeat(10_000)
  const emailSpec: AgentCardSpec = {
    ...formSpec,
    blocks: [{ input: 'textarea', key: 'body', label: 'Message', maxLength: 100_000, type: 'input' }],
  }
  assert.equal(
    validateAgentCardSubmission({
      actionKey: 'send',
      secrets: {},
      spec: emailSpec,
      values: { body: emailBody },
    }).values.body,
    emailBody,
  )
  assert.throws(
    () => validateAgentCardSubmission({
      actionKey: 'send',
      secrets: { api_key: 'sk' },
      spec: formSpec,
      values: { environment: 'prod', note: 'x'.repeat(501) },
    }),
    AgentCardValueError,
  )
})

test('the response text reports a secret as provided and never by value', () => {
  const text = renderAgentCardResponseText({
    actionLabel: 'Send',
    secretKeys: ['api_key'],
    spec: formSpec,
    values: { environment: 'prod' },
  })
  assert.match(text, /API key: provided/)
  assert.doesNotMatch(text, /sk-live/)
})

test('a response inherits every restriction from its source card message', async () => {
  const writes: unknown[] = []
  await inheritAgentCardResponseBasis({
    messageBasisScope: {
      createMany: async (input: unknown) => {
        writes.push(input)
        return { count: 2 }
      },
    },
  } as never, {
    organizationId: 'organization-id',
    responseMessageId: 'response-id',
    sourceBasis: [
      { scopeId: 'person-id', scopeType: 'user' },
      { scopeId: 'team-id', scopeType: 'team' },
    ],
  })
  assert.deepEqual(writes, [{
    data: [
      {
        messageId: 'response-id',
        organizationId: 'organization-id',
        scopeId: 'person-id',
        scopeType: 'user',
      },
      {
        messageId: 'response-id',
        organizationId: 'organization-id',
        scopeId: 'team-id',
        scopeType: 'team',
      },
    ],
    skipDuplicates: true,
  }])
})

test('an unrestricted card response creates no basis rows', async () => {
  let called = false
  await inheritAgentCardResponseBasis({
    messageBasisScope: {
      createMany: async () => {
        called = true
        return { count: 0 }
      },
    },
  } as never, {
    organizationId: 'organization-id',
    responseMessageId: 'response-id',
    sourceBasis: [],
  })
  assert.equal(called, false)
})

test('the plain-text rendering names the buttons and what is asked for', () => {
  const text = renderAgentCardPlainText(formSpec)
  assert.match(text, /Deploy hotfix/)
  assert.match(text, /Asks for: Environment, Note, API key \(secret\)/)
  assert.match(text, /Buttons: Send, Cancel/)
})

test('an open card reads as open in context, and a resolved one as resolved', () => {
  const open = buildAgentCardStateNote({
    expiresAt: null,
    resolutionValues: {},
    resolvedActionKey: null,
    resolvedAtLabel: null,
    resolvedByName: null,
    secretKeys: [],
    spec: formSpec,
    status: 'open',
    waitingForNames: ['Ondrej'],
  })
  assert.match(open, /open, waiting for Ondrej/)

  const resolved = buildAgentCardStateNote({
    expiresAt: null,
    resolutionValues: { environment: 'prod' },
    resolvedActionKey: 'send',
    resolvedAtLabel: '2026-09-02T09:14:00.000Z',
    resolvedByName: 'Ondrej',
    secretKeys: ['api_key'],
    spec: formSpec,
    status: 'resolved',
    waitingForNames: [],
  })
  assert.match(resolved, /resolved: Send by Ondrej/)
  assert.match(resolved, /environment=prod/)
  assert.match(resolved, /secret "api_key": provided/)
})

test('the presenter replaces a secret destination with a label, never an instance id', () => {
  const presented = presentAgentCardBlocks(formSpec, { api_key: 'Linear' })
  const secret = presented.find((block) => block.type === 'secret')
  assert.ok(secret && secret.type === 'secret')
  assert.equal(secret.destinationLabel, 'Linear')
  assert.equal(JSON.stringify(presented).includes(INSTANCE), false)
})
