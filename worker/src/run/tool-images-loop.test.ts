import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { FileService, InferenceResult, ProviderMessage } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import { runAgenticLoop, type BudgetLimits } from './agentic-loop.js'
import {
  coverProviderInputComponent,
  finalizeProvenancedProviderInput,
} from './execute/provenanced-provider-input.js'
import { createToolImageInference } from './execute/tool-image-inference.js'
import type { LoopResumeState } from './loop-resume.js'
import type { ToolImageSource } from './message-attachments.js'
import { isToolImagesMessage, TOOL_IMAGES_INTRO } from './tool-images.js'

/**
 * A screenshot through the loop: a tool result that names its image by
 * reference, the one images turn after the batch, the bytes read in only when
 * each provider input is built — and a crash checkpoint that carries the
 * reference and never the bytes, from which a resumed run reads the picture
 * again.
 */

const RUN_ID = '00000000-0000-4000-8000-0000000000a1'
const COMMAND_ID = '00000000-0000-4000-8000-0000000000b1'
const ATTACHMENT_ID = '0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c01'
// A distinctive run of bytes, so its base64 cannot turn up by chance.
const SCREENSHOT = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(96, 0x5a)])
const SCREENSHOT_BASE64 = SCREENSHOT.toString('base64')
const IMAGE_REF = { attachmentId: ATTACHMENT_ID, byteLength: SCREENSHOT.length, mimeType: 'image/png' }

const HIGH = 1_000_000
const budget: BudgetLimits = {
  maxCostCents: HIGH, maxIterations: HIGH, maxTokens: HIGH,
  maxToolCalls: HIGH, maxWallclockMs: HIGH, toolTimeoutMs: HIGH,
}

const callbacks = (checkpoints: string[]) => ({
  onBudgetExhausted: async () => undefined,
  onCheckpoint: async (state: LoopResumeState) => { checkpoints.push(JSON.stringify(state)) },
  onIterationStart: async () => undefined,
  onTextDelta: async () => undefined,
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
})

const files = (): { reads: string[]; source: ToolImageSource } => {
  const reads: string[] = []
  return {
    reads,
    source: {
      files: {
        openStream: async (id: string) => {
          reads.push(id)
          return { attachment: { mime: 'image/png' }, stream: Readable.from([SCREENSHOT]) }
        },
      } as unknown as FileService,
      organizationId: '00000000-0000-4000-8000-0000000000c1',
      prisma: {
        attachment: {
          findMany: async () => [{
            executorCommandId: COMMAND_ID, filename: 'kelpie-screenshot-1.png', id: ATTACHMENT_ID,
            kind: 'image', mime: 'image/png', sizeBytes: BigInt(SCREENSHOT.length), thumbnailKey: null,
          }],
        },
        executorCommand: { findMany: async () => [{ id: COMMAND_ID }] },
      } as unknown as PrismaClient,
      runId: RUN_ID,
    },
  }
}

const turn = (toolCalls: InferenceResult['toolCalls'], outputText = ''): InferenceResult => ({
  correlationId: undefined, finishReason: toolCalls.length ? 'tool-call' : 'stop', invocations: [], model: 'm',
  outputText, provider: 'openai', requestId: 'r', toolCalls,
})

// The run's prompt, admitted by its source adapter as the prompt builder does.
const prompt = (): ProviderMessage[] => [
  coverProviderInputComponent({ content: 'Evaluate example.com', role: 'user' }, 'conversation'),
]

const screenshotCall = { arguments: { server: 'kelpie', tool: 'kelpie_screenshot' }, toolCallId: 'call-1', toolName: 'executor_mcp_call' }

/** The main loop's inference as `agent-loop.ts` wires it, over a vision connector. */
const scriptedModel = (source: ToolImageSource, script: InferenceResult[]) => {
  const inference = createToolImageInference(source)
  const sent: ProviderMessage[][] = []
  const runInference = (messages: ProviderMessage[]) => inference.infer(async (prepareMessages) => {
    const providerInput = await prepareMessages(messages, { supportsVision: true })
    sent.push(providerInput)
    // Local inference opens only a wholly covered input; this one must be.
    assert.equal(finalizeProvenancedProviderInput(providerInput).kind, 'ready')
    return script.shift() ?? turn([], 'done')
  })
  return { runInference, sent }
}

const lastImages = (messages: ProviderMessage[] | undefined) => {
  const last = messages?.at(-1)
  return last?.role === 'user' ? last.images ?? [] : []
}

const screenshotTool = () => {
  let executions = 0
  return {
    executeTool: async () => {
      executions += 1
      return {
        imageRefs: [IMAGE_REF],
        inputSummary: 'server=kelpie',
        output: 'Output of the program `kelpie`\n[image 1: screenshot, 1 KB]',
        success: true,
      }
    },
    executions: () => executions,
  }
}

test('a screenshot reaches the model after its batch, and every checkpoint holds its reference only', async () => {
  const { reads, source } = files()
  const checkpoints: string[] = []
  const tool = screenshotTool()
  const model = scriptedModel(source, [turn([screenshotCall])])
  const result = await runAgenticLoop({
    budget, callbacks: callbacks(checkpoints), executeTool: tool.executeTool,
    initialMessages: prompt(),
    runInference: model.runInference, tools: [],
  })
  assert.equal(result.finalText, 'done')
  const [, assistant, toolResult, images] = result.messages
  assert.equal(assistant?.role, 'assistant')
  assert.equal(toolResult?.role, 'tool')
  assert.ok(images && isToolImagesMessage(images), 'one images turn right after the batch')
  assert.equal(images.content.split('\n')[0], TOOL_IMAGES_INTRO)
  assert.equal(images.images, undefined, 'the transcript holds no bytes')
  assert.deepEqual(lastImages(model.sent[1]), [{ dataBase64: SCREENSHOT_BASE64, mime: 'image/png' }])
  assert.deepEqual(reads, [ATTACHMENT_ID])

  assert.ok(checkpoints.length > 0)
  for (const state of checkpoints) assert.equal(state.includes(SCREENSHOT_BASE64), false, 'no checkpoint carries the bytes')
  const recorded = checkpoints.map((state) => JSON.parse(state) as LoopResumeState)
  assert.ok(recorded.some((state) => state.toolResults['call-1']?.imageRefs?.[0]?.attachmentId === ATTACHMENT_ID))
  assert.ok(recorded.some((state) => state.messages.some((message) => isToolImagesMessage(message))))
})

test('a run resumed from a checkpoint reads the picture again from FileService', async () => {
  const first = files()
  const checkpoints: string[] = []
  const tool = screenshotTool()
  await runAgenticLoop({
    budget, callbacks: callbacks(checkpoints), executeTool: tool.executeTool,
    initialMessages: prompt(),
    runInference: scriptedModel(first.source, [turn([screenshotCall])]).runInference, tools: [],
  })
  const states = checkpoints.map((state) => JSON.parse(state) as LoopResumeState)

  // Died after the batch closed: the images turn is in the transcript.
  const afterBatch = states.find((state) => state.pendingToolCalls === null
    && state.messages.some((message) => isToolImagesMessage(message)))
  assert.ok(afterBatch)
  const resumed = files()
  const resumedModel = scriptedModel(resumed.source, [])
  await runAgenticLoop({
    budget, callbacks: callbacks([]), executeTool: tool.executeTool, initialMessages: [],
    resume: afterBatch, runInference: resumedModel.runInference, tools: [],
  })
  assert.deepEqual(lastImages(resumedModel.sent[0]), [{ dataBase64: SCREENSHOT_BASE64, mime: 'image/png' }])
  assert.deepEqual(resumed.reads, [ATTACHMENT_ID], 'rehydrated from FileService, not from the checkpoint')

  // Died mid-batch, after the call was recorded: the batch is re-entered from
  // the record, the tool does not run again, and the picture still arrives.
  const midBatch = states.find((state) => state.pendingToolCalls !== null && state.toolResults['call-1'])
  assert.ok(midBatch)
  const reentered = files()
  const reenteredModel = scriptedModel(reentered.source, [])
  const executionsBefore = tool.executions()
  const replay = await runAgenticLoop({
    budget, callbacks: callbacks([]), executeTool: tool.executeTool, initialMessages: [],
    resume: midBatch, runInference: reenteredModel.runInference, tools: [],
  })
  assert.equal(tool.executions(), executionsBefore, 'answered from the record')
  assert.ok(replay.messages.some((message) => isToolImagesMessage(message)))
  assert.deepEqual(lastImages(reenteredModel.sent[0]), [{ dataBase64: SCREENSHOT_BASE64, mime: 'image/png' }])
})
