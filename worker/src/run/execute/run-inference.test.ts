import assert from 'node:assert/strict'
import test from 'node:test'

import type { PinnedFetch } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { createRunInference, resolveAdvertisedOutputTokens, resolveMainOutputTokens } from './run-inference.js'
import type { RunSubscriptionBinding } from './subscription-binding.js'
import type { ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutionDependencies, RunContext } from './types.js'

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
  assert.equal(resolveAdvertisedOutputTokens({
    configuredMaxTokens: 12_000,
    ledgerMaxOutputTokens: 8_192,
  }), 8_192)
  assert.equal(resolveAdvertisedOutputTokens({
    configuredMaxTokens: 12_000,
    staticMaxOutputTokens: 16_384,
  }), 12_000)
  assert.equal(resolveAdvertisedOutputTokens({ configuredMaxTokens: 12_000 }), 12_000)
})

const inferenceDeps = { prisma: {} } as unknown as ExecutionDependencies
const inferencePayload = {
  actorContext: {
    actionContext: { requestId: 'r' },
    actor: { actorId: 'u', actorType: 'user' },
    tenant: { organizationId: 'o', projectId: 'p', teamId: 't' },
  },
} as unknown as RunExecuteJobPayload
const inferenceContext = {
  agent: {
    agentKind: 'shared',
    effort: 'low',
    executionMode: 'inference',
    id: 'a',
    model: 'gemini-test',
    name: 'A',
    parentAgentId: null,
    provider: 'gemini',
    systemPrompt: null,
  },
  channel: { organizationId: 'o' },
  run: { createdAt: new Date(), id: 'run', replyPlacement: null, threadId: 'thread' },
  task: { id: 'task' },
} as unknown as RunContext
const thinkingRecorder = {} as ThinkingRecorder

test('mainOutputTokens applies Ledger metadata and retains the configured cap on listing failure', async () => {
  const make = (fetchImpl: PinnedFetch) => createRunInference(
    inferenceDeps,
    inferencePayload,
    inferenceContext,
    {
      budgetModelOverride: null,
      inferenceServiceFactory: () => ({
        getCapabilities: async () => ({ effectiveSnapshot: { maxOutputTokens: 9_000 } }),
      }),
      ledgerCatalogFetch: fetchImpl,
      stageProviderResolver: async () => ({
        apiKey: 'key',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/gemini',
        connectorKind: 'openai-compatible',
        model: 'gemini-test',
        providerKey: 'gemini',
      }),
      subscription: null,
      thinkingRecorder,
      utilityModel: null,
    },
  )
  let url = ''
  const capped = make(async (input, init) => {
    url = input.toString()
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer key')
    return new Response(JSON.stringify({
      data: [{
        id: 'gemini-test',
        kind: 'service',
        max_output_tokens: 1_024,
        service: { id: 'gemini', name: 'Gemini' },
      }],
    }))
  })
  assert.equal(await capped.mainOutputTokens?.(), 1024)
  assert.equal(url, 'https://ledger.unlikeotherai.com/v1/models')
  const failed = make(async () => { throw new Error('offline') })
  assert.equal(await failed.mainOutputTokens?.(), 2_048)
})

test('mainOutputTokens stays on the pinned subscription lane without a Ledger lookup', async () => {
  const binding: RunSubscriptionBinding = {
    epoch: 7,
    ownerUserId: 'subscription-owner',
    providerKey: 'glm',
    subscriptionId: 'subscription-1',
  }
  let ledgerCatalogCalled = false
  let resolverSubscription: unknown
  let serviceConfig: unknown
  const inference = createRunInference(
    inferenceDeps,
    inferencePayload,
    inferenceContext,
    {
      budgetModelOverride: null,
      inferenceServiceFactory: (config) => {
        serviceConfig = config
        return {
          getCapabilities: async () => ({ effectiveSnapshot: { maxOutputTokens: 1_024 } }),
        }
      },
      ledgerCatalogFetch: async () => {
        ledgerCatalogCalled = true
        throw new Error('subscription runs must not list Ledger models')
      },
      stageProviderResolver: async (_prisma, input) => {
        resolverSubscription = input.subscription
        return {
          apiKey: 'subscription-access-token',
          baseUrl: 'https://api.z.ai/api/paas/v4',
          connectorKind: 'openai-compatible',
          model: 'glm-4.6',
          providerKey: 'openai-compatible',
        }
      },
      subscription: binding,
      thinkingRecorder,
      utilityModel: null,
    },
  )

  assert.equal(await inference.mainOutputTokens?.(), 1_024)
  assert.deepEqual(resolverSubscription, {
    ownerUserId: binding.ownerUserId,
    secretStore: null,
    subscriptionId: binding.subscriptionId,
  })
  assert.deepEqual(serviceConfig, {
    apiKey: 'subscription-access-token',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelName: 'glm-4.6',
    provider: 'openai-compatible',
    serviceId: 'openai-compatible',
  })
  assert.equal(ledgerCatalogCalled, false)
})

