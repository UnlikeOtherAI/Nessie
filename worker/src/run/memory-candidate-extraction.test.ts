import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { InvocationRecord } from '@nessie/runtime'
import { MemoryConsolidationInferenceOriginSchema } from '@nessie/schemas'

import {
  createMemoryCandidateExtractor,
  MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS,
} from './memory-candidate-extraction.js'
import type { runInferenceGraph } from './inference.js'
import type { resolveUtilityModel } from './execute/utility-model.js'

const ids = Array.from(
  { length: 9 },
  (_, index) => `00000000-0000-4000-8000-0000000000${index + 10}`,
)
const origin = MemoryConsolidationInferenceOriginSchema.parse({
  actorId: ids[0],
  actorType: 'system',
  agentId: ids[0],
  agentKind: 'system',
  organizationId: ids[1],
  userId: ids[2],
  teamId: ids[3],
  projectId: ids[4],
  channelId: ids[5],
  threadId: ids[6],
  taskId: ids[7],
  runId: ids[8],
  requestId: `memory-consolidation:${ids[8]}`,
  systemComponent: 'memory-consolidation',
  toolCallId: `memory-consolidation:${ids[8]}:capture`,
})
const invocation: InvocationRecord = {
  invocationId: 'memory-extraction-invocation',
  latencyMs: 10,
  model: 'utility-model',
  operationType: 'chat',
  provider: 'openai',
  requestId: origin.requestId,
  usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
}

const extractionInput = {
  messages: [{
    content: 'pls rember: spuštění zůstává jen pro pozvané 招待制です',
    id: '00000000-0000-4000-8000-000000000099',
    role: 'user' as const,
  }],
}

test('utility extraction is bounded, attributed, and metered before JSON is parsed', async () => {
  const order: string[] = []
  let signed = false
  let inferenceInput: Parameters<typeof runInferenceGraph>[1] | undefined
  const prisma = {} as PrismaClient
  const extractor = createMemoryCandidateExtractor({
    ledgerIdentity: {
      requestHeaders: async (attribution) => {
        signed = true
        assert.deepEqual(attribution, origin)
        return { 'X-Nessie-Context': 'signed' }
      },
    },
    prisma,
    recordUsage: (async (_prisma, input) => {
      order.push('meter')
      assert.deepEqual(input.attribution, origin)
      assert.deepEqual(input.invocations, [invocation])
    }) as typeof import('@nessie/runtime').recordInferenceUsage,
    resolveUtility: (async (_prisma, input) => {
      return { model: 'utility-model', provider: input.providerKey }
    }) as typeof resolveUtilityModel,
    runInference: (async (_prisma, input) => {
      order.push('infer')
      inferenceInput = input
      await input.requestHeadersForProvider?.({
        apiKey: 'ledger-key',
        baseUrl: 'https://ledger.unlikeotherai.com/v1/openai',
        connectorKind: 'openai-compatible',
        model: 'utility-model',
        providerKey: 'openai',
      })
      return {
        correlationId: origin.requestId,
        finalAnswer: JSON.stringify({
          candidates: [{
            content: extractionInput.messages[0]!.content,
            importance: 0.84,
            memoryCategory: 'constraint',
            sourceMessageIds: [extractionInput.messages[0]!.id],
          }],
        }),
        invocations: [invocation],
        requestId: origin.requestId,
        status: 'completed',
        toolCalls: [],
        toolExecutionOwner: null,
      }
    }) as typeof runInferenceGraph,
  }, { origin })

  const raw = await extractor(extractionInput)
  assert.deepEqual(order, ['infer', 'meter'])
  assert.equal(signed, true)
  assert.equal(inferenceInput?.maxOutputTokensOverride, MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS)
  assert.equal(inferenceInput?.reasoningEffort, 'low')
  assert.equal(inferenceInput?.tools, undefined)
  assert.equal(inferenceInput?.agent.model, 'utility-model')
  const prompt = JSON.parse(String(inferenceInput?.baseMessages[0]?.content)) as Record<string, unknown>
  assert.equal('task' in prompt, false, 'unproven task text never enters the inference')
  assert.deepEqual(raw, JSON.parse(JSON.stringify(raw)))
})

test('memory routing is deployment-billed and never reads or mutates a source-run pin', async () => {
  let utilityProvider: string | null | undefined
  let inferenceInput: Parameters<typeof runInferenceGraph>[1] | undefined
  let sourcePinAccesses = 0
  const prisma = new Proxy({} as PrismaClient, {
    get(target, property, receiver) {
      if (property === 'run') sourcePinAccesses += 1
      return Reflect.get(target, property, receiver)
    },
  })
  const extractor = createMemoryCandidateExtractor({
    prisma,
    recordUsage: (async () => undefined) as typeof import('@nessie/runtime').recordInferenceUsage,
    resolveUtility: (async (_prisma, input) => {
      utilityProvider = input.providerKey
      return { model: 'deployment-utility', provider: input.providerKey }
    }) as typeof resolveUtilityModel,
    runInference: (async (_prisma, input) => {
      inferenceInput = input
      return {
        correlationId: origin.requestId,
        finalAnswer: '{"candidates":[]}',
        invocations: [invocation],
        requestId: origin.requestId,
        status: 'completed',
        toolCalls: [],
        toolExecutionOwner: null,
      }
    }) as typeof runInferenceGraph,
  }, { origin })

  await extractor(extractionInput)
  assert.notEqual(utilityProvider, 'subscription/codex')
  assert.notEqual(inferenceInput?.agent.provider, 'subscription/codex')
  assert.equal(inferenceInput?.subscription, undefined)
  assert.equal(sourcePinAccesses, 0, 'memory extraction never reads or changes the source run pin')
})

test('malformed and provider failures propagate, with completed invocations still metered', async () => {
  const prisma = {} as PrismaClient
  let metered = 0
  const malformed = createMemoryCandidateExtractor({
    prisma,
    recordUsage: (async () => { metered += 1 }) as typeof import('@nessie/runtime').recordInferenceUsage,
    resolveUtility: (async () => null) as typeof resolveUtilityModel,
    runInference: (async () => ({
      correlationId: origin.requestId,
      finalAnswer: 'not json',
      invocations: [invocation],
      requestId: origin.requestId,
      status: 'completed',
      toolCalls: [],
      toolExecutionOwner: null,
    })) as typeof runInferenceGraph,
  }, { origin })
  await assert.rejects(malformed(extractionInput), SyntaxError)
  assert.equal(metered, 1)

  const providerFailure = createMemoryCandidateExtractor({
    prisma,
    recordUsage: (async () => { metered += 1 }) as typeof import('@nessie/runtime').recordInferenceUsage,
    resolveUtility: (async () => null) as typeof resolveUtilityModel,
    runInference: (async () => { throw new Error('provider unavailable') }) as typeof runInferenceGraph,
  }, { origin })
  await assert.rejects(providerFailure(extractionInput), /provider unavailable/)
  assert.equal(metered, 1)
})
