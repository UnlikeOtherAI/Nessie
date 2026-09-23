import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  ProviderInvocationError,
  type FileService,
  type InferenceResult,
  type ProviderMessage,
} from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import type { PrepareProviderMessages } from '../inference.js'
import type { ToolImageSource } from '../message-attachments.js'
import { buildToolImagesMessage, TOOL_IMAGES_NOT_SEEN_NOTE } from '../tool-images.js'
import { coverProviderInputComponent } from './provenanced-provider-input.js'
import { createToolImageInference } from './tool-image-inference.js'

const RUN_ID = '00000000-0000-4000-8000-0000000000a1'
const COMMAND_ID = '00000000-0000-4000-8000-0000000000b1'
const ATTACHMENT_ID = '0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c01'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])

const source = (): { reads: string[]; source: ToolImageSource } => {
  const reads: string[] = []
  return {
    reads,
    source: {
      files: {
        openStream: async (id: string) => {
          reads.push(id)
          return { attachment: { mime: 'image/png' }, stream: Readable.from([PNG]) }
        },
      } as unknown as FileService,
      organizationId: '00000000-0000-4000-8000-0000000000c1',
      prisma: {
        attachment: {
          findMany: async () => [{
            executorCommandId: COMMAND_ID, filename: 'kelpie-screenshot-1.png', id: ATTACHMENT_ID,
            kind: 'image', mime: 'image/png', sizeBytes: 5n, thumbnailKey: null,
          }],
        },
        executorCommand: { findMany: async () => [{ id: COMMAND_ID }] },
      } as unknown as PrismaClient,
      runId: RUN_ID,
    },
  }
}

const transcript = (): ProviderMessage[] => [
  coverProviderInputComponent({ content: 'Evaluate example.com', role: 'user' }, 'conversation'),
  coverProviderInputComponent(buildToolImagesMessage([{
    imageRefs: [{ attachmentId: ATTACHMENT_ID, byteLength: 5, mimeType: 'image/png' }],
    toolName: 'executor_mcp_call',
  }])!, 'tool_images'),
]

const answer: InferenceResult = {
  correlationId: undefined, finishReason: 'stop', invocations: [], model: 'm', outputText: 'done',
  provider: 'openai', requestId: 'r', toolCalls: [],
}

const refusal = (message: string, statusCode = 400) => new ProviderInvocationError(
  `openai-compatible chat request failed with HTTP ${statusCode}: ${message}`,
  {
    finishReason: 'error', invocationId: 'i', latencyMs: 1, model: 'meta/muse-spark-1.3-contributor',
    operationType: 'chat', provider: 'openai-compatible', requestId: 'r', usage: {},
  },
  undefined,
  { statusCode },
)

/** A provider whose connector says the model can see, answering from `script`. */
const provider = (script: Array<'ok' | Error>) => {
  const sent: ProviderMessage[][] = []
  const call = async (prepareMessages: PrepareProviderMessages): Promise<InferenceResult> => {
    sent.push(await prepareMessages(transcript(), { supportsVision: true }))
    const next = script.shift() ?? 'ok'
    if (next instanceof Error) throw next
    return answer
  }
  return { call, sent }
}

const imageCount = (messages: ProviderMessage[] | undefined): number =>
  (messages ?? []).reduce((sum, message) => sum + (message.role === 'user' ? message.images?.length ?? 0 : 0), 0)

test('a vision connector’s call carries the run’s tool images, read at the moment it is built', async () => {
  const { reads, source: files } = source()
  const inference = createToolImageInference(files)
  const { call, sent } = provider(['ok'])
  assert.equal(await inference.infer(call), answer)
  assert.equal(imageCount(sent[0]), 1)
  assert.deepEqual(reads, [ATTACHMENT_ID])
})

test('a provider that refuses the images is asked once more without them, and the run carries on', async () => {
  const { reads, source: files } = source()
  const inference = createToolImageInference(files)
  const first = provider([refusal('This model does not support image input'), 'ok'])
  assert.equal(await inference.infer(first.call), answer)
  assert.equal(first.sent.length, 2, 'retried exactly once')
  assert.equal(imageCount(first.sent[0]), 1)
  assert.equal(imageCount(first.sent[1]), 0, 'the retry strips every image')
  assert.match((first.sent[1]![1] as { content: string }).content, new RegExp(TOOL_IMAGES_NOT_SEEN_NOTE.replace(/[()]/g, '\\$&')))

  // The rest of the run treats the model as one that cannot see.
  const later = provider(['ok'])
  await inference.infer(later.call)
  assert.equal(imageCount(later.sent[0]), 0)
  assert.equal(reads.length, 1, 'nothing is read for it any more')

  // And a second image refusal is not retried again.
  const again = provider([refusal('Invalid image_url')])
  await assert.rejects(inference.infer(again.call), /Invalid image_url/)
  assert.equal(again.sent.length, 1)
})

test('only a refusal of a request that carried images is retried; the second refusal fails the call', async () => {
  const { source: files } = source()
  const inference = createToolImageInference(files)
  const other = provider([refusal('invalid parameter')])
  await assert.rejects(inference.infer(other.call), /invalid parameter/)
  assert.equal(other.sent.length, 1)

  const twice = provider([refusal('image input is not supported'), refusal('image input is not supported')])
  await assert.rejects(inference.infer(twice.call), /image input is not supported/)
  assert.equal(twice.sent.length, 2)

  // A text-only request the provider refuses in words about images is not ours to strip.
  const noImages = createToolImageInference(files)
  let calls = 0
  await assert.rejects(noImages.infer(async (prepare) => {
    calls += 1
    await prepare([coverProviderInputComponent({ content: 'hi', role: 'user' }, 'conversation')], { supportsVision: true })
    throw refusal('This model does not support image input')
  }), /does not support image input/)
  assert.equal(calls, 1)
})
