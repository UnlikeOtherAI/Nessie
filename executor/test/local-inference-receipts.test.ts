import assert from 'node:assert/strict'
import test from 'node:test'

import { EncryptedLocalInferenceReceiptJournal, LocalInferenceReceiptError } from '../src/local-inference-receipts.js'
import type { LocalInferenceResult } from '@nessie/schemas'

const receipt = (content: string) => ({
  attemptId: '33333333-3333-4333-8333-333333333333',
  dispatchFence: 1,
  result: {
    capability: {
      discoveredAt: '2026-09-20T10:00:00.000Z', model: 'local:latest', provider: 'local_device', source: 'live',
      structuredOutputMode: 'text-only', supportsChat: true, supportsEmbeddings: false, supportsModelDiscovery: true,
      supportsStreaming: true, supportsVision: false, systemPromptMode: 'native', toolCallingMode: 'disabled',
      toolResultMode: 'native-tool-message', usageReporting: {
        cachedInputTokens: false, cachedOutputTokens: false, cacheReadTokens: false, cacheWriteTokens: false,
        inputTokens: true, outputTokens: true, providerReportedCost: false,
      },
    },
    content, finishReason: 'stop', modelDigest: 'a'.repeat(64), remoteHost: null, remoteModel: null,
    toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 },
  } satisfies LocalInferenceResult,
})

const journal = (now: () => Date) => {
  let encrypted: { ciphertext: string; iv: string; tag: string; version: 1 } | undefined
  return new EncryptedLocalInferenceReceiptJournal({
    read: async () => encrypted,
    remove: async () => { encrypted = undefined },
    write: async (value) => { encrypted = value },
  }, new Uint8Array(32).fill(1), now)
}

test('a receipt is idempotent only for the same result', async () => {
  const store = journal(() => new Date('2026-09-20T10:00:00.000Z'))
  await store.record(receipt('first'))
  await store.record(receipt('first'))
  await assert.rejects(store.record(receipt('changed')), (error: unknown) => (
    error instanceof LocalInferenceReceiptError && error.code === 'receipt_conflict'
  ))
})

test('expired durable receipts are not replayed', async () => {
  let now = new Date('2026-09-20T10:00:00.000Z')
  const store = journal(() => now)
  await store.record(receipt('old result'))
  now = new Date('2026-09-20T11:00:00.000Z')
  assert.equal(await store.get(receipt('old result')), undefined)
})
