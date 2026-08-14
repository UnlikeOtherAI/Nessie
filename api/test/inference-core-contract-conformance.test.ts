import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InvocationRecordSchema as SharedInvocationRecordSchema,
  ProviderInvocationRequestSchema as SharedProviderInvocationRequestSchema,
  ProviderInvocationResultSchema as SharedProviderInvocationResultSchema,
  ProviderMessageContentPartSchema as SharedProviderMessageContentPartSchema,
  ProviderMessageSchema as SharedProviderMessageSchema,
  ProviderStreamEventSchema as SharedProviderStreamEventSchema,
  ToolSchemaDescriptorSchema as SharedToolSchemaDescriptorSchema,
} from '@nessie/schemas'
import type { z } from 'zod'

import {
  InvocationRecordSchema as ApiInvocationRecordSchema,
  ProviderInvocationRequestSchema as ApiProviderInvocationRequestSchema,
  ProviderInvocationResultSchema as ApiProviderInvocationResultSchema,
  ProviderMessageContentPartSchema as ApiProviderMessageContentPartSchema,
  ProviderMessageSchema as ApiProviderMessageSchema,
  ProviderStreamEventSchema as ApiProviderStreamEventSchema,
  ToolSchemaDescriptorSchema as ApiToolSchemaDescriptorSchema,
} from '../src/contracts/inference-core.js'

/**
 * Contract-unification conformance (security-boundary hardening, Workstream 6, S14).
 *
 * The api contracts and the shared schemas describe the same inference wire
 * shapes but serve different audiences (Kimix §4.5), so the api layer is not a
 * blind re-export — it may be *stricter* (uuid invocation ids, defaulted
 * tool-call arrays, non-empty tool descriptions). The invariant is strength,
 * not identity: anything the shared schema rejects, the api contract must also
 * reject. These fixtures fail loudly the next time a named pair drifts the way
 * `imageUrl` and `reasoning_text.delta` did.
 */

type SchemaPair = {
  name: string
  shared: z.ZodTypeAny
  api: z.ZodTypeAny
}

const pairs: SchemaPair[] = [
  {
    name: 'ProviderMessageContentPartSchema',
    shared: SharedProviderMessageContentPartSchema,
    api: ApiProviderMessageContentPartSchema,
  },
  {
    name: 'ProviderMessageSchema',
    shared: SharedProviderMessageSchema,
    api: ApiProviderMessageSchema,
  },
  {
    name: 'ProviderStreamEventSchema',
    shared: SharedProviderStreamEventSchema,
    api: ApiProviderStreamEventSchema,
  },
  {
    name: 'ToolSchemaDescriptorSchema',
    shared: SharedToolSchemaDescriptorSchema,
    api: ApiToolSchemaDescriptorSchema,
  },
  {
    name: 'InvocationRecordSchema',
    shared: SharedInvocationRecordSchema,
    api: ApiInvocationRecordSchema,
  },
  {
    name: 'ProviderInvocationRequestSchema',
    shared: SharedProviderInvocationRequestSchema,
    api: ApiProviderInvocationRequestSchema,
  },
  {
    name: 'ProviderInvocationResultSchema',
    shared: SharedProviderInvocationResultSchema,
    api: ApiProviderInvocationResultSchema,
  },
]

type Fixture = {
  name: string
  input: unknown
  /** The shared schema must reject this input for the assertion to mean anything. */
  sharedRejects: boolean
  /**
   * When set, the fixture applies to exactly these pair names instead of
   * every pair whose shared verdict matches. Use this where two pairs parse
   * overlapping shapes with deliberately different strictness (e.g. the api
   * invocation result defaults `toolCalls` where the shared one requires it).
   */
  only?: string[]
}

const validInvocationRecord = {
  invocationId: '0f9a2f0f-0d9d-4d0a-9c3a-3a2b2a1b0c0d',
  requestId: 'req-conformance-1',
  provider: 'openai',
  model: 'gpt-5',
  operationType: 'chat',
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 12,
}

const validToolDescriptor = {
  toolName: 'web_fetch',
  description: 'Fetch a URL.',
  inputSchema: { type: 'object' },
}

const validInvocationRequest = {
  requestId: 'req-conformance-2',
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'hello' }],
}

const validInvocationResult = {
  outputText: 'hi',
  toolCalls: [],
  invocation: validInvocationRecord,
}

const fixtures: Fixture[] = [
  {
    name: 'non-URL imageUrl',
    input: { type: 'image', imageUrl: 'not-a-url' },
    sharedRejects: true,
  },
  {
    name: 'empty imageUrl',
    input: { type: 'image', imageUrl: '' },
    sharedRejects: true,
  },
  {
    name: 'unknown stream event kind',
    input: { type: 'mystery.delta', text: 'what' },
    sharedRejects: true,
  },
  {
    name: 'reasoning_text.delta stream event',
    input: { type: 'reasoning_text.delta', text: 'thinking…' },
    sharedRejects: false,
  },
  {
    name: 'output_text.delta stream event',
    input: { type: 'output_text.delta', text: 'answer' },
    sharedRejects: false,
  },
  {
    name: 'tool_call.delta stream event',
    input: { type: 'tool_call.delta', index: 0, id: 'call-1', toolName: 'web_fetch', text: '{}' },
    sharedRejects: false,
  },
  {
    name: 'unknown message role',
    input: { role: 'oracle', content: 'boo' },
    sharedRejects: true,
  },
  {
    name: 'assistant message with image parts',
    input: {
      role: 'assistant',
      content: [{ type: 'image', imageUrl: 'https://example.com/cat.png' }],
    },
    sharedRejects: false,
  },
  {
    name: 'tool message without toolCallId',
    input: { role: 'tool', content: 'result' },
    sharedRejects: true,
  },
  {
    name: 'unknown invocation operation type',
    input: { ...validInvocationRecord, operationType: 'sorcery' },
    sharedRejects: true,
  },
  {
    name: 'negative invocation latency',
    input: { ...validInvocationRecord, latencyMs: -1 },
    sharedRejects: true,
  },
  {
    name: 'valid invocation record',
    input: validInvocationRecord,
    sharedRejects: false,
  },
  {
    name: 'tool descriptor with missing inputSchema',
    input: { toolName: 'web_fetch', description: 'Fetch a URL.' },
    sharedRejects: true,
  },
  {
    name: 'valid tool descriptor',
    input: validToolDescriptor,
    sharedRejects: false,
  },
  {
    name: 'invocation request with malformed message',
    input: { ...validInvocationRequest, messages: [{ role: 'oracle', content: 'boo' }] },
    sharedRejects: true,
  },
  {
    name: 'invocation request with non-URL image part',
    input: {
      ...validInvocationRequest,
      messages: [
        { role: 'user', content: [{ type: 'image', imageUrl: 'not-a-url' }] },
      ],
    },
    sharedRejects: true,
  },
  {
    name: 'valid invocation request',
    input: validInvocationRequest,
    sharedRejects: false,
  },
  {
    name: 'invocation result without invocation record',
    input: { outputText: 'hi' },
    sharedRejects: true,
  },
  {
    name: 'valid invocation result',
    input: validInvocationResult,
    sharedRejects: false,
  },
  {
    // Deliberate api-side defaulting: the api contract fills an omitted
    // `toolCalls` with `[]` where the shared schema requires the key. This is
    // the allowed direction of divergence (api stricter/more normalizing on a
    // documented point), so the fixture is pinned to that pair.
    name: 'invocation result with defaulted toolCalls (api-only acceptance)',
    input: { outputText: 'hi', invocation: validInvocationRecord },
    sharedRejects: true,
    only: ['ProviderInvocationResultSchema'],
  },
]

const applicablePairs = (fixture: Fixture): SchemaPair[] => {
  const matching = pairs.filter(
    (pair) =>
      fixture.sharedRejects === !pair.shared.safeParse(fixture.input).success,
  )
  if (!fixture.only) return matching
  const pinned = matching.filter((pair) => fixture.only?.includes(pair.name))
  assert.deepEqual(
    pinned.map((pair) => pair.name).sort(),
    [...fixture.only].sort(),
    `fixture "${fixture.name}" no longer pins to ${fixture.only.join(', ')} — the named pair drifted`,
  )
  return pinned
}

for (const fixture of fixtures) {
  test(`conformance: ${fixture.name}`, () => {
    const matching = applicablePairs(fixture)
    assert.ok(
      matching.length > 0,
      `fixture "${fixture.name}" matches no shared schema as expected; the fixture or the shared schema drifted`,
    )
    for (const pair of matching) {
      const sharedResult = pair.shared.safeParse(fixture.input)
      const apiResult = pair.api.safeParse(fixture.input)
      if (fixture.sharedRejects && !fixture.only) {
        assert.equal(sharedResult.success, false, `${pair.name}: shared schema accepted a fixture it must reject`)
        assert.equal(
          apiResult.success,
          false,
          `${pair.name}: api contract accepted input the shared schema rejects — the api copy has diverged weaker`,
        )
      } else if (fixture.sharedRejects && fixture.only) {
        // Documented divergence point: assert the pair still disagrees in the
        // pinned direction (shared rejects, api accepts by defaulting).
        assert.equal(sharedResult.success, false, `${pair.name}: shared schema accepted a fixture it must reject`)
        assert.equal(
          apiResult.success,
          true,
          `${pair.name}: api contract lost its documented defaulting behavior`,
        )
      } else {
        assert.equal(
          sharedResult.success,
          true,
          `${pair.name}: shared schema rejected a fixture that must stay valid`,
        )
        assert.equal(
          apiResult.success,
          true,
          `${pair.name}: api contract rejected input the shared schema accepts — the api copy has diverged stricter on a valid shape`,
        )
      }
    }
  })
}

// The named divergences from S14, asserted directly so removing the fixture
// coverage above cannot silently re-open them.
test('S14: api imageUrl validation is URL-strict', () => {
  assert.equal(
    ApiProviderMessageContentPartSchema.safeParse({ type: 'image', imageUrl: 'not-a-url' }).success,
    false,
  )
  assert.equal(
    ApiProviderMessageContentPartSchema.safeParse({
      type: 'image',
      imageUrl: 'https://example.com/cat.png',
    }).success,
    true,
  )
})

test('S14: api stream-event union covers reasoning_text.delta', () => {
  assert.equal(
    ApiProviderStreamEventSchema.safeParse({ type: 'reasoning_text.delta', text: 'thinking…' }).success,
    true,
  )
})
