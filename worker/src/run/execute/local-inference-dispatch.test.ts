import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dispatchLocalInference,
  LocalInferenceDispatchError,
  localInferenceFrameEvent,
  localInferenceInvocationId,
  localInferenceRequestDigest,
} from './local-inference-dispatch.js'
import {
  coverProviderInputComponent,
  finalizeProvenancedProviderInput,
} from './provenanced-provider-input.js'
import type { ExecutionDependencies, RunContext } from './types.js'

test('one omitted coverage token returns unclassified_input before attempt or frame bytes', async () => {
  let attemptBytes = 0
  let frameBytes = 0
  const deps = {
    atRestEncryptionKeyRing: { current: { id: 'test', key: Buffer.alloc(32) } },
    prisma: {
      localInferenceAttempt: {
        create: async () => {
          attemptBytes += 1
          throw new Error('must not persist an unclassified request')
        },
      },
      localInferenceFrame: {
        create: async () => {
          frameBytes += 1
          throw new Error('must not emit an unclassified frame')
        },
      },
    },
  } as unknown as ExecutionDependencies
  const context = {
    run: { id: 'run-1' },
  } as unknown as RunContext

  await assert.rejects(
    dispatchLocalInference({
      binding: {
        bindingId: 'binding', hostEpoch: 1, hostId: 'host', manifestDigest: 'a'.repeat(64),
        modelName: 'local-only', numCtx: 8192, revision: 1,
      },
      context,
      deps,
      maxOutputTokens: 16,
      providerInput: finalizeProvenancedProviderInput([
        coverProviderInputComponent(
          { content: 'covered system block', role: 'system' },
          'prompt_system',
        ),
        // Deliberately model the adapter that forgot to issue its token.
        { content: 'unclassified reader output', role: 'user' },
      ]),
      runFence: 'run-fence',
      tools: [],
    }),
    (error: unknown) => error instanceof LocalInferenceDispatchError
      && error.message === 'unclassified_input',
  )
  assert.equal(attemptBytes, 0)
  assert.equal(frameBytes, 0)
})

test('reclaiming a local call ignores a fresh deadline and worker claim fence', () => {
  const first = {
    deadlineAt: '2026-09-20T10:05:00.000Z', model: 'local:latest', prompt: 'same', runFence: 'claim-a', runId: 'run-1',
  }
  const reclaimed = { ...first, deadlineAt: '2026-09-20T10:06:00.000Z', runFence: 'claim-b' }
  assert.equal(localInferenceRequestDigest(first), localInferenceRequestDigest(reclaimed))
  assert.equal(localInferenceInvocationId(first), localInferenceInvocationId(reclaimed))
})

test('an error frame cannot become an empty successful local answer', () => {
  assert.deepEqual(localInferenceFrameEvent({ message: 'ollama_unreachable', retryable: false, type: 'response.error' }), {
    error: 'ollama_unreachable',
  })
  assert.throws(() => localInferenceFrameEvent({ type: 'response.error' }), LocalInferenceDispatchError)
})
