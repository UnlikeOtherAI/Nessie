import assert from 'node:assert/strict'
import test from 'node:test'

import { createRunInference, resolveAdvertisedOutputTokens, resolveMainOutputTokens } from './run-inference.js'

test('document compose never exceeds the loop-admitted output cap', () => {
  assert.equal(resolveMainOutputTokens({
    admittedMaxOutputTokens: 3_000,
    composeAvailable: true,
    configuredMaxTokens: 12_000,
  }), 3_000)
})

test('document compose keeps its configured desired size without a loop cap', () => {
  assert.equal(resolveMainOutputTokens({
    composeAvailable: true,
    configuredMaxTokens: 12_000,
  }), 32_768)
})

test('advertised Ledger output caps lower but never replace the configured cap', () => {
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000, ledgerMaxOutputTokens: 8_192 }), 8_192)
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000, staticMaxOutputTokens: 16_384 }), 12_000)
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000 }), 12_000)
})

test('mainOutputTokens uses the selected Ledger catalog cap and keeps static cap when listing fails', async () => {
  const make = (fetchImpl: typeof fetch) => createRunInference(
    { prisma: {} } as never,
    { actorContext: { actor: { actorId: 'u', actorType: 'user' }, actionContext: { requestId: 'r' }, tenant: { organizationId: 'o', teamId: 't', projectId: 'p' } } } as never,
    { agent: { id: 'a', name: 'A', model: 'gemini-test', provider: 'gemini', effort: 'low', agentKind: 'shared', executionMode: 'inference', parentAgentId: null, systemPrompt: null }, channel: { organizationId: 'o' }, run: { id: 'run', threadId: 'thread', createdAt: new Date(), replyPlacement: null }, task: { id: 'task' } } as never,
    { budgetModelOverride: null, subscription: null, utilityModel: null, thinkingRecorder: {} as never,
      stageProviderResolver: async () => ({ apiKey: 'key', baseUrl: 'https://ledger.example/v1/gemini', connectorKind: 'openai-compatible', model: 'gemini-test', providerKey: 'gemini' }),
      inferenceServiceFactory: () => ({ getCapabilities: async () => ({ effectiveSnapshot: { maxOutputTokens: 9000 } }) }) as never,
      ledgerCatalogFetch: fetchImpl,
    },
  )
  let url = ''
  const capped = make(async (input, init) => { url = input.toString(); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer key'); return new Response(JSON.stringify({ data: [{ id: 'gemini-test', kind: 'service', service: { id: 'gemini', name: 'Gemini' }, max_output_tokens: 4096 }] })) })
  assert.equal(await capped.mainOutputTokens?.(), 4096)
  assert.equal(url, 'https://ledger.example/v1/models')
  const failed = make(async () => { throw new Error('offline') })
  assert.equal(await failed.mainOutputTokens?.(), 9000)
})
