import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertLocalInferenceSerializedSize,
  LOCAL_INFERENCE_MAX_REQUEST_BYTES,
  LocalInferenceResultSchema,
  type LocalInferenceAttemptRequest,
} from '@nessie/schemas'
import { openLocalInferenceAttempt, sealLocalInferenceAttempt, type InferenceResult, type ProviderMessage, type ToolSchemaDescriptor } from '@nessie/runtime'

import { resolveRunLocalInferenceBinding, type RunLocalInferenceBinding } from './local-inference-binding.js'
import type { ExecutionDependencies, RunContext } from './types.js'

export class LocalInferenceDispatchError extends Error {
  override readonly name = 'LocalInferenceDispatchError'
}

const FIVE_MINUTES = 5 * 60_000

/**
 * Durable local-device handoff.  The worker writes one sealed attempt then
 * waits on the receipt row; it never dials an endpoint or retries accepted
 * inference.  A restarted worker recovers the same invocation id/result.
 */
export const dispatchLocalInference = async (input: {
  binding: RunLocalInferenceBinding
  deps: ExecutionDependencies
  maxOutputTokens: number
  messages: ProviderMessage[]
  runFence: string
  context: RunContext
  tools: ToolSchemaDescriptor[]
}): Promise<InferenceResult> => {
  if (!input.deps.atRestEncryptionKeyRing) {
    throw new LocalInferenceDispatchError('Local inference secure storage is unavailable.')
  }
  const current = await resolveRunLocalInferenceBinding(input.deps, input.context)
  if (
    current.kind !== 'local'
    || current.binding.bindingId !== input.binding.bindingId
    || current.binding.hostEpoch !== input.binding.hostEpoch
    || current.binding.revision !== input.binding.revision
  ) throw new LocalInferenceDispatchError('The selected local host needs repair.')

  const invocationId = randomUUID()
  const deadlineAt = new Date(Date.now() + FIVE_MINUTES)
  const request: LocalInferenceAttemptRequest = {
    attemptId: randomUUID(), bindingId: input.binding.bindingId,
    bindingRevision: input.binding.revision, deadlineAt: deadlineAt.toISOString(),
    hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId, invocationId,
    maxOutputTokens: input.maxOutputTokens, messages: input.messages, modelDigest: input.binding.manifestDigest,
    modelName: input.binding.modelName, numCtx: input.binding.numCtx, protocolVersion: 1,
    runFence: input.runFence, runId: input.context.run.id, tools: input.tools,
  }
  try {
    assertLocalInferenceSerializedSize(request, LOCAL_INFERENCE_MAX_REQUEST_BYTES)
  } catch {
    throw new LocalInferenceDispatchError('The local inference request is too large.')
  }
  const existing = await input.deps.prisma.localInferenceAttempt.findUnique({
    where: { invocationId }, select: { id: true },
  })
  if (existing) throw new LocalInferenceDispatchError('Local inference invocation conflict.')
  await input.deps.prisma.localInferenceAttempt.create({
    data: {
      bindingId: input.binding.bindingId, deadlineAt, encryptedRequest: Uint8Array.from(
        sealLocalInferenceAttempt(input.deps.atRestEncryptionKeyRing, request),
      ), hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId,
      id: request.attemptId, invocationId, organizationId: input.context.channel.organizationId,
      requestDigest: input.binding.manifestDigest, runFence: input.runFence, runId: input.context.run.id,
    },
  })
  while (Date.now() < deadlineAt.getTime()) {
    const row = await input.deps.prisma.localInferenceAttempt.findUnique({
      where: { id: request.attemptId },
      select: { encryptedResult: true, failureReason: true, state: true },
    })
    if (row?.state === 'completed' && row.encryptedResult) {
      const result = LocalInferenceResultSchema.parse(openLocalInferenceAttempt(
        input.deps.atRestEncryptionKeyRing, row.encryptedResult as Uint8Array,
      ))
      if (result.remoteHost !== null || result.remoteModel !== null) {
        throw new LocalInferenceDispatchError('The local host reported a remote model.')
      }
      return {
        finishReason: result.finishReason,
        invocations: [{
          invocationId, latencyMs: 0, model: input.binding.modelName,
          operationType: 'chat', provider: 'openai-compatible', requestId: invocationId,
          usage: {
            ...(result.usage.inputTokens === null ? {} : { inputTokens: result.usage.inputTokens }),
            ...(result.usage.outputTokens === null ? {} : { outputTokens: result.usage.outputTokens }),
          },
        }],
        model: input.binding.modelName, outputText: result.content ?? '', provider: 'openai-compatible',
        requestId: invocationId, toolCalls: result.toolCalls,
      }
    }
    if (row?.state === 'cancelled' || row?.state === 'expired' || row?.state === 'failed') {
      throw new LocalInferenceDispatchError(row.failureReason ?? 'The local inference attempt did not complete.')
    }
    const run = await input.deps.prisma.run.findUnique({
      where: { id: input.context.run.id }, select: { cancelRequestedAt: true },
    })
    if (run?.cancelRequestedAt) {
      await input.deps.prisma.localInferenceAttempt.updateMany({
        where: { id: request.attemptId, state: { in: ['queued', 'leased', 'accepted'] } },
        data: { failureReason: 'cancelled', state: 'cancelled', terminalAt: new Date() },
      })
      throw new LocalInferenceDispatchError('The local inference attempt was cancelled.')
    }
    await delay(250)
  }
  await input.deps.prisma.localInferenceAttempt.updateMany({
    where: { id: request.attemptId, state: { in: ['queued', 'leased', 'accepted'] } },
    data: { failureReason: 'deadline_exceeded', state: 'expired', terminalAt: new Date() },
  })
  throw new LocalInferenceDispatchError('The local inference attempt timed out.')
}
