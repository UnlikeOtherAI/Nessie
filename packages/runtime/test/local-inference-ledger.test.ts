import assert from 'node:assert/strict'
import test from 'node:test'

import { recordInferenceUsage } from '../src/ledger.js'

test('a local device invocation is metered without a price or cloud model identity', async () => {
  let pricingLookups = 0
  let providerLookups = 0
  let rows: Array<Record<string, unknown>> = []
  const prisma = {
    inferenceProvider: {
      findFirst: async () => {
        providerLookups += 1
        return null
      },
    },
    modelPricingProfile: {
      findFirst: async () => {
        pricingLookups += 1
        return null
      },
    },
    tokenLedgerEvent: {
      createMany: async (input: { data: Array<Record<string, unknown>> }) => {
        rows = input.data
        return { count: input.data.length }
      },
    },
  }

  await recordInferenceUsage(prisma as never, {
    attribution: {
      actorId: '00000000-0000-4000-8000-000000000001',
      actorType: 'agent',
      localDevice: {
        bindingId: '00000000-0000-4000-8000-000000000002',
        hostId: '00000000-0000-4000-8000-000000000003',
      },
      organizationId: '00000000-0000-4000-8000-000000000004',
      requestId: 'local-invocation',
    },
    invocations: [{
      invocationId: 'local-invocation',
      latencyMs: 12,
      model: 'gemma4:12b',
      operationType: 'chat',
      provider: 'openai-compatible',
      providerReportedCost: { amount: 19, currency: 'USD' },
      requestId: 'local-invocation',
      usage: { inputTokens: 5, outputTokens: 7 },
    }],
  })

  assert.equal(pricingLookups, 0)
  assert.equal(providerLookups, 0)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    actorId: '00000000-0000-4000-8000-000000000001',
    actorType: 'agent',
    agentId: null,
    billingSource: 'local_device',
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cachedInputTokens: null,
    cachedOutputTokens: null,
    channelId: null,
    correlationId: null,
    estimatedCostAmount: null,
    estimatedCostCurrency: null,
    inferenceInvocationId: 'local-invocation',
    inputTokens: 5,
    localInferenceBindingId: '00000000-0000-4000-8000-000000000002',
    localInferenceHostId: '00000000-0000-4000-8000-000000000003',
    metadata: { invocationId: 'local-invocation', latencyMs: 12 },
    model: 'gemma4:12b',
    modelId: null,
    modelSubscriptionId: null,
    occurredAt: rows[0]?.occurredAt,
    operationType: 'chat',
    organizationId: '00000000-0000-4000-8000-000000000004',
    outputTokens: 7,
    pricingCurrency: null,
    pricingInputPerM: null,
    pricingOutputPerM: null,
    pricingProfileId: null,
    pricingSource: null,
    projectId: null,
    provider: 'openai-compatible',
    providerCostAmount: null,
    providerCostCurrency: null,
    providerId: null,
    requestId: 'local-invocation',
    runId: null,
    sessionId: null,
    taskId: null,
    teamId: null,
    threadId: null,
    totalTokens: null,
    userId: null,
  })
})
