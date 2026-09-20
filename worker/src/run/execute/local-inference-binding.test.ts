import assert from 'node:assert/strict'
import test from 'node:test'

import { persistRunLocalInferenceBinding } from './local-inference-binding.js'

const binding = {
  bindingId: 'binding-id',
  hostEpoch: 7,
  hostId: 'host-id',
  manifestDigest: 'a'.repeat(64),
  modelName: 'tiny-local',
  numCtx: 8192,
  revision: 3,
}

test('local admission pins one exact binding before provider selection', async () => {
  type UpdateInput = { data: unknown; where: unknown }
  const updates: UpdateInput[] = []
  const prisma = {
    run: {
      updateMany: async (input: UpdateInput) => {
        updates.push(input)
        return { count: 1 }
      },
    },
  }
  await persistRunLocalInferenceBinding(prisma as never, { binding, runId: 'run-id' })

  assert.deepEqual(updates[0]?.data, {
    localInferenceBindingId: 'binding-id',
    localInferenceBindingRevision: 3,
    localInferenceHostEpoch: 7,
    localInferenceHostId: 'host-id',
    localInferenceModelDigest: 'a'.repeat(64),
  })
  assert.deepEqual(updates[0]?.where, {
    id: 'run-id',
    OR: [
      {
        localInferenceBindingId: null,
        localInferenceBindingRevision: null,
        localInferenceHostEpoch: null,
        localInferenceHostId: null,
        localInferenceModelDigest: null,
      },
      {
        localInferenceBindingId: 'binding-id',
        localInferenceBindingRevision: 3,
        localInferenceHostEpoch: 7,
        localInferenceHostId: 'host-id',
        localInferenceModelDigest: 'a'.repeat(64),
      },
    ],
  })
})

test('a changed local run pin fails closed', async () => {
  await assert.rejects(
    persistRunLocalInferenceBinding({
      run: { updateMany: async () => ({ count: 0 }) },
    } as never, { binding, runId: 'run-id' }),
    /run pin changed/,
  )
})
