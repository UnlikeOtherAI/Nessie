import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sealLocalInferenceAttempt } from '@nessie/runtime'
import type { LocalInferenceResult } from '@nessie/schemas'
import { dispatchLocalInference, recoverCompletedLocalInferenceResult } from './local-inference-dispatch.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { coverProviderInputComponent, finalizeProvenancedProviderInput } from './provenanced-provider-input.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const fixture = () => {
  const ownerUserId = randomUUID()
  const organizationId = randomUUID()
  const binding = {
    bindingId: randomUUID(), hostId: randomUUID(), hostEpoch: 1, revision: 1,
    manifestDigest: 'a'.repeat(64), modelName: 'fixture:local', numCtx: 8192,
  }
  const keyRing = { activeVersion: 'fixture', keys: { fixture: 'fixture-secret' } }
  const result: LocalInferenceResult = {
    capability: {
      discoveredAt: new Date().toISOString(), model: binding.modelName, provider: 'local_device', source: 'live',
      structuredOutputMode: 'text-only', supportsChat: true, supportsEmbeddings: false, supportsModelDiscovery: true,
      supportsStreaming: true, supportsVision: false, systemPromptMode: 'native', toolCallingMode: 'disabled',
      toolResultMode: 'native-tool-message', usageReporting: {
        inputTokens: true, outputTokens: true, cachedInputTokens: false, cachedOutputTokens: false,
        cacheReadTokens: false, cacheWriteTokens: false, providerReportedCost: false,
      },
    },
    content: 'saved before the deadline', finishReason: 'stop', modelDigest: binding.manifestDigest,
    remoteHost: null, remoteModel: null, toolCalls: [], usage: { inputTokens: 2, outputTokens: 4 },
  }
  const state = { epoch: 1, enabled: true, ownerUserId, creates: 0, expired: 0, online: true, revoked: false }
  let attempt: {
    id: string; invocationId: string; requestDigest: string; modelDigest: string; deadlineAt: Date;
    state: string; encryptedResult: Uint8Array;
  } | null = null
  const prisma = {
    agentLocalInferenceBinding: { findFirst: async () => ({ ...binding, id: binding.bindingId, policyVersion: 0 }) },
    localInferenceHost: { findFirst: async () => ({
      id: binding.hostId, custodianUserId: state.ownerUserId, connectionEpoch: state.epoch,
      inventoryObservedAt: new Date(), lastSeenAt: state.online ? new Date() : null,
      pausedAt: null, revokedAt: state.revoked ? new Date() : null,
      inventory: [{
        capabilities: ['text'], manifestDigest: binding.manifestDigest, name: binding.modelName,
        numCtxCap: 8192, remoteHost: null, remoteModel: null, reportedAt: new Date().toISOString(), sizeBytes: 100,
      }],
    }) },
    organization: { findUnique: async () => ({ externalOrgId: null }) },
    organizationMember: { findFirst: async () => ({ id: 'local-fixture-membership' }) },
    scopedSetting: { findMany: async () => [{
      key: 'inference.localAgents.enabled', scope: 'organization', value: state.enabled, locked: false,
    }] },
    localInferencePolicyVersion: { findUnique: async () => ({ version: 0 }) },
    channelMember: { findMany: async () => [] }, teamMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] }, agent: { findMany: async () => [] },
    localInferenceFrame: { findFirst: async () => null },
    localInferenceAttempt: {
      findUnique: async () => attempt,
      findMany: async () => attempt ? [attempt] : [],
      create: async ({ data }: { data: NonNullable<typeof attempt> }) => {
        state.creates += 1
        attempt = { ...data, state: 'completed', encryptedResult: sealLocalInferenceAttempt(keyRing, result) }
      },
      updateMany: async () => { state.expired += 1; return { count: 1 } },
    },
  }
  const context = {
    agent: { id: randomUUID(), ownerUserId, provider: 'local/ollama', localInferenceBindingId: binding.bindingId },
    channel: { organizationId }, run: { id: randomUUID() }, consumedSources: createConsumedSourceSink(),
  } as unknown as RunContext
  const providerInput = finalizeProvenancedProviderInput([
    coverProviderInputComponent({ role: 'user', content: 'Process the pinned row' }, 'direct_prompt'),
  ])
  return {
    state,
    recover: () => recoverCompletedLocalInferenceResult({
      binding, context, deps: { atRestEncryptionKeyRing: keyRing, prisma } as unknown as ExecutionDependencies,
    }),
    changeAttempt: (changes: Partial<NonNullable<typeof attempt>>) => {
      assert.ok(attempt)
      Object.assign(attempt, changes)
    },
    dispatch: () => dispatchLocalInference({
      binding, context, deps: { atRestEncryptionKeyRing: keyRing, prisma } as unknown as ExecutionDependencies,
      providerInput, runFence: randomUUID(), tools: [],
    }),
  }
}

test('a completed local receipt survives its deadline and a new host epoch without a new generation', async () => {
  const item = fixture()
  assert.equal((await item.dispatch()).outputText, 'saved before the deadline')
  item.changeAttempt({ deadlineAt: new Date('2000-01-01') })
  assert.equal((await item.dispatch()).outputText, 'saved before the deadline')
  item.state.epoch = 2
  assert.equal((await item.dispatch()).outputText, 'saved before the deadline')
  assert.equal(item.state.creates, 1)
  assert.equal(item.state.expired, 0)
})

test('an unfinished old-epoch call cannot be dispatched under a newly connected host', async () => {
  const item = fixture()
  await item.dispatch()
  item.changeAttempt({ state: 'accepted' })
  item.state.epoch = 2
  await assert.rejects(item.dispatch(), /needs repair/)
  assert.equal(item.state.creates, 1)
  assert.equal(item.state.expired, 0)
})

test('receipt recovery still rejects disabled policy and a changed custodian', async () => {
  const item = fixture()
  await item.dispatch()
  item.changeAttempt({ deadlineAt: new Date('2000-01-01') })
  item.state.enabled = false
  await assert.rejects(item.dispatch(), /needs repair/)
  item.state.enabled = true
  item.state.ownerUserId = randomUUID()
  await assert.rejects(item.dispatch(), /needs repair/)
  assert.equal(item.state.creates, 1)
})

test('an unfinished call still expires after its original deadline', async () => {
  const item = fixture()
  await item.dispatch()
  item.changeAttempt({ deadlineAt: new Date('2000-01-01'), state: 'accepted' })
  await assert.rejects(item.dispatch(), /timed out/)
  assert.equal(item.state.expired, 1)
  assert.equal(item.state.creates, 1)
})

test('a known final receipt is recoverable while its host is offline, but authority is still live', async () => {
  const item = fixture()
  await item.dispatch()
  item.changeAttempt({ deadlineAt: new Date('2000-01-01') })
  item.state.epoch = 2
  item.state.online = false
  assert.equal((await item.recover())?.outputText, 'saved before the deadline')
  await assert.rejects(item.dispatch(), /needs repair/)
  item.state.enabled = false
  assert.equal(await item.recover(), null)
  item.state.enabled = true
  item.state.revoked = true
  assert.equal(await item.recover(), null)
  item.state.revoked = false
  item.state.ownerUserId = randomUUID()
  assert.equal(await item.recover(), null)
  assert.equal(item.state.creates, 1)
})

test('offline recovery cannot turn an unfinished request into a new generation', async () => {
  const item = fixture()
  await item.dispatch()
  item.state.online = false
  item.changeAttempt({ state: 'accepted' })
  assert.equal(await item.recover(), null)
  assert.equal(item.state.creates, 1)
})
