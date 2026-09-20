import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertLocalInferenceSerializedSize,
  LOCAL_INFERENCE_MAX_REQUEST_BYTES,
  LocalInferenceResultSchema,
  type LocalInferenceAttemptRequest,
} from '@nessie/schemas'
import { openLocalInferenceAttempt, sealLocalInferenceAttempt, type InferenceResult, type ToolSchemaDescriptor } from '@nessie/runtime'

import { resolveRunLocalInferenceBinding, type RunLocalInferenceBinding } from './local-inference-binding.js'
import { openProvenancedProviderInput, type ProviderInputFinalization } from './provenanced-provider-input.js'
import { authorizeLocalInferenceRecipient } from './local-inference-recipient.js'
import type { ExecutionDependencies, RunContext } from './types.js'

export class LocalInferenceDispatchError extends Error {
  override readonly name = 'LocalInferenceDispatchError'
}

const FIVE_MINUTES = 5 * 60_000

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex')

const uuidFromDigest = (value: string): string => (
  `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`
)

/**
 * Durable local-device handoff.  The worker writes one sealed attempt then
 * waits on the receipt row; it never dials an endpoint or retries accepted
 * inference.  A restarted worker recovers the same invocation id/result.
 */
export const dispatchLocalInference = async (input: {
  binding: RunLocalInferenceBinding
  deps: ExecutionDependencies
  maxOutputTokens: number
  providerInput: ProviderInputFinalization
  runFence: string
  context: RunContext
  onTextDelta?: (text: string) => Promise<void>
  tools: ToolSchemaDescriptor[]
}): Promise<InferenceResult> => {
  // A provider input reaches the delivery store only after every ordered
  // component has a distinct source-adapter token. This stays before every
  // database read/write so an omitted adapter leaks neither an attempt nor a
  // frame byte.
  const messages = input.providerInput.kind === 'ready'
    ? openProvenancedProviderInput(input.providerInput.providerInput)
    : null
  if (!messages) {
    throw new LocalInferenceDispatchError('unclassified_input')
  }
  if (!input.deps.atRestEncryptionKeyRing) {
    throw new LocalInferenceDispatchError('Local inference secure storage is unavailable.')
  }
  const current = await resolveRunLocalInferenceBinding(input.deps, input.context)
  // This re-resolves the binding, host and live entitlement immediately before
  // persistence; its owner/custodian equality check is the recipient check,
  // not a fact trusted from the earlier run admission.
  if (
    current.kind !== 'local'
    || current.binding.bindingId !== input.binding.bindingId
    || current.binding.hostEpoch !== input.binding.hostEpoch
    || current.binding.revision !== input.binding.revision
  ) throw new LocalInferenceDispatchError('The selected local host needs repair.')
  if (!(await authorizeLocalInferenceRecipient(input.deps, input.context))) {
    throw new LocalInferenceDispatchError('source_not_allowed')
  }

  const deadlineAt = new Date(Date.now() + FIVE_MINUTES)
  const requestIdentity = {
    bindingId: input.binding.bindingId,
    bindingRevision: input.binding.revision, deadlineAt: deadlineAt.toISOString(),
    hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId,
    maxOutputTokens: input.maxOutputTokens, messages, modelDigest: input.binding.manifestDigest,
    modelName: input.binding.modelName, numCtx: input.binding.numCtx, protocolVersion: 1,
    runFence: input.runFence, runId: input.context.run.id, tools: input.tools,
  }
  const requestDigest = digest(requestIdentity)
  const attemptId = uuidFromDigest(digest({ requestDigest, type: 'attempt' }))
  const invocationId = uuidFromDigest(digest({ requestDigest, type: 'invocation' }))
  const request: LocalInferenceAttemptRequest = {
    ...requestIdentity, attemptId, invocationId,
  }
  try {
    assertLocalInferenceSerializedSize(request, LOCAL_INFERENCE_MAX_REQUEST_BYTES)
  } catch {
    throw new LocalInferenceDispatchError('The local inference request is too large.')
  }
  const existing = await input.deps.prisma.localInferenceAttempt.findUnique({
    where: { invocationId }, select: { id: true, modelDigest: true, requestDigest: true },
  })
  if (existing && (existing.id !== request.attemptId || existing.requestDigest !== requestDigest
    || existing.modelDigest !== input.binding.manifestDigest)) {
    throw new LocalInferenceDispatchError('Local inference invocation conflict.')
  }
  if (!existing) {
    await input.deps.prisma.localInferenceAttempt.create({
      data: {
        bindingId: input.binding.bindingId, deadlineAt, encryptedRequest: Uint8Array.from(
          sealLocalInferenceAttempt(input.deps.atRestEncryptionKeyRing, request),
        ), hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId,
        id: request.attemptId, invocationId, modelDigest: input.binding.manifestDigest,
        organizationId: input.context.channel.organizationId,
        requestDigest, runFence: input.runFence, runId: input.context.run.id,
      },
    })
  }
  const consumeFrames = async (): Promise<void> => {
    for (;;) {
      const frame = await input.deps.prisma.localInferenceFrame.findFirst({
        where: { acknowledgedAt: null, attemptId: request.attemptId },
        orderBy: { sequence: 'asc' },
        select: { encryptedData: true, id: true },
      })
      if (!frame) return
      let event: unknown
      try {
        const sealed = openLocalInferenceAttempt<{ data: string }>(
          input.deps.atRestEncryptionKeyRing,
          frame.encryptedData as Uint8Array,
        )
        event = JSON.parse(Buffer.from(sealed.data, 'base64url').toString('utf8')) as unknown
      } catch {
        throw new LocalInferenceDispatchError('The local inference stream frame was invalid.')
      }
      const parsed = event !== null && typeof event === 'object' && !Array.isArray(event)
        ? event as Record<string, unknown>
        : null
      const text = parsed?.type === 'output_text.delta' && typeof parsed.text === 'string'
        ? parsed.text
        : null
      const error = parsed?.type === 'response.error' && typeof parsed.message === 'string'
        && parsed.message.length > 0 && parsed.message.length <= 200
        ? parsed.message
        : null
      if (!text && !error) {
        throw new LocalInferenceDispatchError('The local inference stream frame was invalid.')
      }
      const acknowledged = await input.deps.prisma.localInferenceFrame.updateMany({
        where: { acknowledgedAt: null, id: frame.id },
        data: { acknowledgedAt: new Date() },
      })
      if (acknowledged.count !== 1) continue
      if (error) throw new LocalInferenceDispatchError(error)
      if (text) await input.onTextDelta?.(text)
    }
  }
  while (Date.now() < deadlineAt.getTime()) {
    await consumeFrames()
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
