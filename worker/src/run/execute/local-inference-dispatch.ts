import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  assertLocalInferenceSerializedSize,
  LOCAL_INFERENCE_MAX_REQUEST_BYTES,
  LocalInferenceAttemptRequestSchema,
  LocalInferenceResultSchema,
  type LocalInferenceAttemptRequest,
} from '@nessie/schemas'
import { openLocalInferenceAttempt, sealLocalInferenceAttempt, type InferenceResult, type ToolSchemaDescriptor } from '@nessie/runtime'

import {
  resolveLocalInferenceReceiptBinding, resolveRunLocalInferenceBinding, type RunLocalInferenceBinding,
} from './local-inference-binding.js'
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

/** Lease timing and the current worker claim fence cannot identify a model call. */
export const localInferenceRequestDigest = (input: Record<string, unknown>): string => {
  const logicalRequest = { ...input }
  delete logicalRequest.deadlineAt
  delete logicalRequest.runFence
  return digest(logicalRequest)
}

export const localInferenceInvocationId = (input: Record<string, unknown>): string => {
  const requestDigest = localInferenceRequestDigest(input)
  return uuidFromDigest(digest({ requestDigest, type: 'invocation' }))
}

export const localInferenceFrameEvent = (
  event: unknown,
): { error?: string; reasoning?: string; text?: string } => {
  const parsed = event !== null && typeof event === 'object' && !Array.isArray(event)
    ? event as Record<string, unknown>
    : null
  const text = parsed?.type === 'output_text.delta' && typeof parsed.text === 'string'
    ? parsed.text
    : undefined
  // The host's own thinking frames, in the same vocabulary every cloud
  // connector emits, so the thought log needs no local special case.
  const reasoning = parsed?.type === 'reasoning_text.delta' && typeof parsed.text === 'string'
    ? parsed.text
    : undefined
  const error = parsed?.type === 'response.error' && typeof parsed.message === 'string'
    && parsed.message.length > 0 && parsed.message.length <= 200
    ? parsed.message
    : undefined
  if (!text && !reasoning && !error) {
    throw new LocalInferenceDispatchError('The local inference stream frame was invalid.')
  }
  return {
    ...(text ? { text } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(error ? { error } : {}),
  }
}

const decodeReceipt = (
  keyRing: NonNullable<ExecutionDependencies['atRestEncryptionKeyRing']>,
  binding: RunLocalInferenceBinding, invocationId: string, encryptedResult: Uint8Array,
): InferenceResult => {
  const result = LocalInferenceResultSchema.parse(openLocalInferenceAttempt(keyRing, encryptedResult))
  if (result.remoteHost !== null || result.remoteModel !== null || result.modelDigest !== binding.manifestDigest) {
    throw new LocalInferenceDispatchError('The local host reported an unpinned model.')
  }
  if (result.finishReason === 'error') throw new LocalInferenceDispatchError('The local inference host reported an error.')
  return {
    finishReason: result.finishReason,
    invocations: [{
      invocationId, latencyMs: 0, model: binding.modelName, operationType: 'chat',
      provider: 'openai-compatible', requestId: invocationId,
      usage: {
        ...(result.usage.inputTokens === null ? {} : { inputTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === null ? {} : { outputTokens: result.usage.outputTokens }),
      },
    }],
    model: binding.modelName, outputText: result.content ?? '', provider: 'openai-compatible',
    ...(result.reasoning ? { reasoningText: result.reasoning } : {}),
    requestId: invocationId, toolCalls: result.toolCalls,
  }
}

/** Recovery never creates a request, re-pins a host or relaxes recipient authority. */
export const recoverCompletedLocalInferenceResult = async (input: {
  binding: RunLocalInferenceBinding; deps: ExecutionDependencies; context: RunContext;
}): Promise<InferenceResult | null> => {
  const keyRing = input.deps.atRestEncryptionKeyRing
  if (!keyRing) return null
  const current = await resolveLocalInferenceReceiptBinding(input.deps, input.context)
  if (current.kind !== 'local' || current.binding.bindingId !== input.binding.bindingId
    || current.binding.hostId !== input.binding.hostId || current.binding.revision !== input.binding.revision
    || current.binding.manifestDigest !== input.binding.manifestDigest
    || current.binding.modelName !== input.binding.modelName || current.binding.numCtx !== input.binding.numCtx
    || !await authorizeLocalInferenceRecipient(input.deps, input.context)) return null
  const attempts = await input.deps.prisma.localInferenceAttempt.findMany({
    where: { runId: input.context.run.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 33,
  })
  if (attempts.length === 0 || attempts.length > 32) return null
  let final: InferenceResult | null = null
  for (const attempt of attempts) {
    if (final || attempt.state !== 'completed' || !attempt.encryptedRequest || !attempt.encryptedResult) return null
    const request = LocalInferenceAttemptRequestSchema.parse(openLocalInferenceAttempt(
      keyRing, attempt.encryptedRequest,
    ))
    if (request.runId !== input.context.run.id || request.bindingId !== input.binding.bindingId
      || request.hostId !== input.binding.hostId || request.hostEpoch !== input.binding.hostEpoch
      || request.bindingRevision !== input.binding.revision || request.modelDigest !== input.binding.manifestDigest
      || request.modelName !== input.binding.modelName || request.numCtx !== input.binding.numCtx) return null
    const result = decodeReceipt(keyRing, input.binding, attempt.invocationId, attempt.encryptedResult)
    if (result.toolCalls.length === 0) final = result
  }
  return final
}

/**
 * Durable local-device handoff.  The worker writes one sealed attempt then
 * waits on the receipt row; it never dials an endpoint or retries accepted
 * inference.  A restarted worker recovers the same invocation id/result.
 */
export const dispatchLocalInference = async (input: {
  binding: RunLocalInferenceBinding
  deps: ExecutionDependencies
  maxOutputTokens?: number
  providerInput: ProviderInputFinalization
  runFence: string
  signal?: AbortSignal
  context: RunContext
  onReasoningDelta?: (text: string) => Promise<void>
  onTextDelta?: (text: string) => Promise<void>
  /** Ask the host for the model's separate thinking (a live, shown turn). */
  thinking: boolean
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
  const atRestEncryptionKeyRing = input.deps.atRestEncryptionKeyRing
  if (!atRestEncryptionKeyRing) {
    throw new LocalInferenceDispatchError('Local inference secure storage is unavailable.')
  }
  const current = await resolveRunLocalInferenceBinding(input.deps, input.context)
  // This re-resolves the binding, host and live entitlement immediately before
  // persistence; its owner/custodian equality check is the recipient check,
  // not a fact trusted from the earlier run admission.
  if (
    current.kind !== 'local'
    || current.binding.bindingId !== input.binding.bindingId
    || current.binding.revision !== input.binding.revision
    || current.binding.manifestDigest !== input.binding.manifestDigest
    || current.binding.modelName !== input.binding.modelName
    || current.binding.numCtx !== input.binding.numCtx
  ) throw new LocalInferenceDispatchError('The selected local host needs repair.')
  if (!(await authorizeLocalInferenceRecipient(input.deps, input.context))) {
    throw new LocalInferenceDispatchError('source_not_allowed')
  }

  const proposedDeadline = new Date(Date.now() + FIVE_MINUTES)
  const requestIdentity = {
    bindingId: input.binding.bindingId,
    bindingRevision: input.binding.revision,
    hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    messages, modelDigest: input.binding.manifestDigest,
    modelName: input.binding.modelName, numCtx: input.binding.numCtx, protocolVersion: 1 as const,
    runId: input.context.run.id, ...(input.thinking ? { thinking: true } : {}), tools: input.tools,
  }
  const requestDigest = localInferenceRequestDigest({
    ...requestIdentity, deadlineAt: proposedDeadline.toISOString(), runFence: input.runFence,
  })
  const attemptId = uuidFromDigest(digest({ requestDigest, type: 'attempt' }))
  const invocationId = localInferenceInvocationId({
    ...requestIdentity, deadlineAt: proposedDeadline.toISOString(), runFence: input.runFence,
  })
  const request: LocalInferenceAttemptRequest = {
    ...requestIdentity, attemptId, deadlineAt: proposedDeadline.toISOString(), invocationId, runFence: input.runFence,
  }
  try {
    assertLocalInferenceSerializedSize(request, LOCAL_INFERENCE_MAX_REQUEST_BYTES)
  } catch {
    throw new LocalInferenceDispatchError('The local inference request is too large.')
  }
  const existing = await input.deps.prisma.localInferenceAttempt.findUnique({
    where: { invocationId },
    select: { deadlineAt: true, encryptedResult: true, id: true, modelDigest: true, requestDigest: true, state: true },
  })
  if (existing && (existing.id !== request.attemptId || existing.requestDigest !== requestDigest
    || existing.modelDigest !== input.binding.manifestDigest)) {
    throw new LocalInferenceDispatchError('Local inference invocation conflict.')
  }
  // Reconnection cannot authorize a new request under an old native epoch.
  // The exact already-persisted result may still be consumed after the live
  // owner, binding, policy and disclosure checks above have succeeded.
  if (current.binding.hostEpoch !== input.binding.hostEpoch
    && !(existing?.state === 'completed' && existing.encryptedResult)) {
    throw new LocalInferenceDispatchError('The selected local host needs repair.')
  }
  if (!existing) {
    await input.deps.prisma.localInferenceAttempt.create({
      data: {
        bindingId: input.binding.bindingId, deadlineAt: proposedDeadline, encryptedRequest: Uint8Array.from(
          sealLocalInferenceAttempt(atRestEncryptionKeyRing, request),
        ), hostEpoch: input.binding.hostEpoch, hostId: input.binding.hostId,
        id: request.attemptId, invocationId, modelDigest: input.binding.manifestDigest,
        organizationId: input.context.channel.organizationId,
        requestDigest, runFence: input.runFence, runId: input.context.run.id,
      },
    })
  }
  const deadlineAt = existing?.deadlineAt ?? proposedDeadline
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
          atRestEncryptionKeyRing,
          frame.encryptedData as Uint8Array,
        )
        event = JSON.parse(Buffer.from(sealed.data, 'base64url').toString('utf8')) as unknown
      } catch {
        throw new LocalInferenceDispatchError('The local inference stream frame was invalid.')
      }
      const { error, reasoning, text } = localInferenceFrameEvent(event)
      const acknowledged = await input.deps.prisma.localInferenceFrame.updateMany({
        where: { acknowledgedAt: null, id: frame.id },
        data: { acknowledgedAt: new Date() },
      })
      if (acknowledged.count !== 1) continue
      if (error) throw new LocalInferenceDispatchError(error)
      if (reasoning) await input.onReasoningDelta?.(reasoning)
      if (text) await input.onTextDelta?.(text)
    }
  }
  for (;;) {
    // A worker drain abandons waiting, not the durable generation. Its
    // successor recovers the same invocation and the host keeps its slot.
    input.signal?.throwIfAborted()
    const row = await input.deps.prisma.localInferenceAttempt.findUnique({
      where: { id: request.attemptId },
      select: { encryptedResult: true, failureReason: true, state: true },
    })
    if (row?.state === 'completed' && row.encryptedResult) {
      await consumeFrames()
      return decodeReceipt(atRestEncryptionKeyRing, input.binding, invocationId, row.encryptedResult)
    }
    if (row?.state === 'cancelled' || row?.state === 'expired' || row?.state === 'failed') {
      throw new LocalInferenceDispatchError(row.failureReason ?? 'The local inference attempt did not complete.')
    }
    // Deadline limits generation, not recovery of a receipt already accepted
    // before that deadline. A later worker still consumes that exact result.
    if (Date.now() >= deadlineAt.getTime()) break
    await consumeFrames()
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
