import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { recordAuthorizedExecutorCommandAttachment } from '@nessie/executor-manage'
import { collectStream, type ProviderMessage } from '@nessie/runtime'
import { AuthorizedActionContextSchema } from '@nessie/schemas'

import {
  ATTACHMENT_SECRET,
  attachmentTestPrisma,
  digestOf,
  kelpieScreenshot,
  seedAttachmentWorld,
} from '../../../packages/executor-manage/test/command-attachment-fixture.js'
import { loadCrashCheckpoint, persistCrashCheckpoint } from '../../src/run/execute/crash-checkpoint.js'
import { createExecutorToolExecution } from '../../src/run/execute/executor-tool-execution.js'
import { coverProviderInputComponent } from '../../src/run/execute/provenanced-provider-input.js'
import type { ExecutionDependencies, RunContext } from '../../src/run/execute/types.js'
import type { ExecutorToolset } from '../../src/run/executor-toolset.js'
import type { LoopResumeState } from '../../src/run/loop-resume.js'
import { renderPromptImages } from '../../src/run/message-attachments.js'
import { buildToolImagesMessage, isToolImagesMessage } from '../../src/run/tool-images.js'
import { runDatabaseTest } from './support.js'

/**
 * A local program's screenshot from its stored attachment to the model's
 * prompt, against a real database and a real filesystem FileService: the
 * daemon's upload kept through `recordAuthorizedExecutorCommandAttachment`,
 * the worker resolving the result's reference to that attachment through
 * the command's ToolCall, the images turn holding only the reference, a real
 * crash checkpoint written and read back with no bytes in it, and the loader
 * reading the picture from FileService for this run and for no other.
 */

const resumeState = (messages: ProviderMessage[]): LoopResumeState => ({
  budgetRecoveryAttempted: false, compactionAttempts: 0, compactionLastIteration: null, elapsedMs: 0,
  invocations: [], iterations: 1, lastAssistantText: '', messages, outputFinalizationPending: false,
  outputFinalizationReason: null, outputFinalizationUsed: false, pendingToolCalls: null, retriesUsed: 0,
  signatureCounts: {}, toolCallsUsed: 1, toolFailureCounts: {}, toolMs: 0, toolResults: {}, woundDown: false,
})

runDatabaseTest('a kept screenshot reaches the prompt through its attachment, and a checkpoint holds only its reference', async () => {
  const prisma = attachmentTestPrisma()
  const world = await seedAttachmentWorld(prisma)
  let taskId: string | undefined
  try {
    const screenshot = kelpieScreenshot()
    const commandId = await world.createCommand('started')
    const stored = await recordAuthorizedExecutorCommandAttachment(prisma, {
      encryptionSecret: ATTACHMENT_SECRET, fileService: world.fileService,
    }, world.upload(commandId, screenshot))
    assert.ok(stored)
    const { toolCallId } = await prisma.executorCommand.findUniqueOrThrow({ where: { id: commandId }, select: { toolCallId: true } })

    // The terminal result as the daemon left it: a reference and a marker, no bytes.
    const digest = digestOf(screenshot)
    const result = {
      inputSummary: 'server=kelpie',
      output: JSON.stringify({
        content: [
          { text: `{"format":"png","image":"[image: attachment ${digest}]"}`, type: 'text' },
          { attachmentDigest: digest, byteLength: screenshot.length, mimeType: 'image/png', type: 'image' },
        ],
        success: true,
      }),
      success: true,
      toolCallRecordId: toolCallId,
    }
    const toolset = { dispatch: async () => result } as unknown as ExecutorToolset
    const actor = AuthorizedActionContextSchema.parse({
      actor: { actorId: world.holderId, actorType: 'user' }, actionContext: { requestId: randomUUID() },
      tenant: { organizationId: world.organizationId },
    })
    const execute = (runId: string) => createExecutorToolExecution(
      { prisma } as unknown as ExecutionDependencies,
      { run: { id: runId } } as unknown as RunContext,
      toolset,
    )('executor_mcp_call', { server: 'kelpie', tool: 'kelpie_screenshot' }, 'provider-call-1', actor)

    const presented = await execute(world.runId)
    assert.ok(presented.output.split('\n').includes('[image 1: screenshot, 13 KB]'))
    assert.deepEqual(presented.imageRefs, [{ attachmentId: stored.id, byteLength: 13_715, mimeType: 'image/png' }])
    // Another run cannot resolve this run's command.
    const elsewhere = await execute(randomUUID())
    assert.equal(elsewhere.imageRefs, undefined)
    assert.match(elsewhere.output, /\[image unavailable: Nessie does not hold it for this call\]/)

    const imagesTurn = buildToolImagesMessage([{ ...presented, toolName: 'executor_mcp_call' }])!
    const transcript: ProviderMessage[] = [
      coverProviderInputComponent({ content: 'Evaluate example.com', role: 'user' }, 'conversation'),
      coverProviderInputComponent(imagesTurn, 'tool_images'),
    ]

    // A real crash checkpoint of that transcript, read back.
    const task = await prisma.task.create({
      data: { agentId: world.agentId, organizationId: world.organizationId, runId: world.runId },
    })
    taskId = task.id
    const executorToken = randomUUID()
    await prisma.run.update({ where: { id: world.runId }, data: { executorToken } })
    const written = await persistCrashCheckpoint(prisma, {
      agentId: world.agentId, organizationId: world.organizationId, rootMessageId: null,
      runId: world.runId, taskId: task.id, threadId: world.threadId,
    }, executorToken, resumeState(transcript))
    assert.equal(written, 1)
    const raw = await prisma.runCheckpoint.findUniqueOrThrow({ where: { runId: world.runId }, select: { crashState: true } })
    const storedBytes = await collectStream((await world.fileService.openStream(stored.id, world.organizationId))!.stream)
    const encoded = JSON.stringify(raw.crashState)
    assert.equal(encoded.includes(storedBytes.toString('base64').slice(0, 200)), false, 'no image bytes in the checkpoint')
    assert.equal(encoded.includes(screenshot.toString('base64').slice(0, 200)), false)
    assert.ok(encoded.includes(stored.id), 'the reference is')
    const resumed = await loadCrashCheckpoint(prisma, world.runId)
    assert.ok(resumed)
    assert.ok(resumed.messages.some((message) => isToolImagesMessage(message)))

    // Rehydrated from FileService, for this run.
    const source = { files: world.fileService, organizationId: world.organizationId, prisma, runId: world.runId }
    const rendered = await renderPromptImages(resumed.messages, source, { supportsVision: true })
    const last = rendered.at(-1)!
    assert.equal(last.role, 'user')
    assert.deepEqual(last.role === 'user' ? last.images : null, [{ dataBase64: storedBytes.toString('base64'), mime: 'image/png' }])

    // A transcript carried into another run reads nothing.
    const foreign = await renderPromptImages(resumed.messages, { ...source, runId: randomUUID() }, { supportsVision: true })
    const foreignLast = foreign.at(-1)!
    assert.equal(foreignLast.role === 'user' ? foreignLast.images : null, undefined)
    assert.match(foreignLast.content ?? '', /\(could not be loaded\)$/)
  } finally {
    try {
      await prisma.runCheckpoint.deleteMany({ where: { runId: world.runId } })
      if (taskId) await prisma.task.deleteMany({ where: { id: taskId } })
      await world.cleanup()
    } finally {
      await prisma.$disconnect()
    }
  }
})
