import {
  LOCAL_INFERENCE_PROTOCOL_VERSION,
  LocalInferenceResourceAdmissionSchema,
  LocalInferenceResourceControlSchema,
  type LocalInferenceAttemptRequest,
  type LocalInferenceResult,
  type LocalInferenceEnvelopePurpose,
  type ModelCapabilitySnapshot,
  type ObservedLocalModel,
} from '@nessie/schemas'
import { signLocalInferenceEnvelope, signLocalInferenceResourceAttachment } from '@nessie/local-inference-host'

import {
  LocalInferenceApiError,
  type LocalInferenceDaemonApi,
  type LocalInferenceResultReceipt as ApiResultReceipt,
} from './local-inference-api.js'
import {
  EncryptedLocalInferenceReceiptJournal,
  LocalInferenceReceiptError,
  type LocalInferenceResultReceipt as JournalResultReceipt,
} from './local-inference-receipts.js'
import { streamOllamaChat, OllamaChatError } from './ollama-chat.js'
import {
  isStructurallyLocalOllamaModel,
  observeOllamaInventory,
  type ObservedOllamaModel,
} from './ollama-observed.js'
import { type OllamaFetch } from './ollama-client.js'
import type { LocalInferenceCoordinator, LocalInferenceCoordinatorLease } from './local-inference-coordinator.js'

const MAX_FRAME_BYTES = 16 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const CONTROL_POLL_INTERVAL_MS = 250

export type LocalInferenceHostIdentity = {
  connectionEpoch: string
  executorConnectionEpoch?: string
  hostId: string
  machinePrivateKey: string
  organizationId: string
}

export type LocalInferencePollOutcome =
  | { kind: 'idle' }
  | { kind: 'refused'; reason: 'protected_storage_unavailable' }
  | { attemptId: string; kind: 'completed' }
  | { attemptId: string; kind: 'fenced' }

type EligibleModel = ObservedOllamaModel

const knownCapabilities = (model: ObservedOllamaModel): ObservedLocalModel['capabilities'] => {
  const capabilities = new Set<ObservedLocalModel['capabilities'][number]>()
  // These are documented Ollama capability values, not a model-name heuristic.
  if (model.capabilities.includes('completion')) capabilities.add('text')
  if (model.capabilities.includes('tools')) capabilities.add('tools')
  if (model.capabilities.includes('structured_output')) capabilities.add('json_schema')
  return [...capabilities]
}

const publishedModel = (model: ObservedOllamaModel, reportedAt: string): ObservedLocalModel => ({
  capabilities: knownCapabilities(model),
  manifestDigest: model.manifestDigest,
  name: model.name,
  numCtxCap: model.numCtxCap,
  remoteHost: model.remoteHost,
  remoteModel: model.remoteModel,
  reportedAt,
  sizeBytes: model.sizeBytes,
})

const deadlinePassed = (attempt: LocalInferenceAttemptRequest, now: Date): boolean => (
  new Date(attempt.deadlineAt).valueOf() <= now.valueOf()
)

const matchesSelectedModel = (
  model: ObservedOllamaModel,
  attempt: LocalInferenceAttemptRequest,
): model is EligibleModel => (
  isStructurallyLocalOllamaModel(model)
  && model.name === attempt.modelName
  && model.manifestDigest === attempt.modelDigest
)

const outputFramePayload = (text: string): string => JSON.stringify({ type: 'output_text.delta', text })

const splitFrames = (text: string): string[] => {
  const frames: string[] = []
  let current = ''
  for (const codePoint of text) {
    const candidate = current + codePoint
    if (Buffer.byteLength(outputFramePayload(candidate), 'utf8') <= MAX_FRAME_BYTES) {
      current = candidate
      continue
    }
    if (!current) throw new Error('A local inference output character exceeds the frame limit.')
    frames.push(current)
    current = codePoint
  }
  if (current) frames.push(current)
  return frames
}

const frameData = (text: string): string => Buffer.from(outputFramePayload(text), 'utf8').toString('base64url')

const capabilityFor = (
  attempt: LocalInferenceAttemptRequest,
  model: EligibleModel,
  now: Date,
): ModelCapabilitySnapshot => ({
  discoveredAt: now.toISOString(),
  lastVerifiedAt: now.toISOString(),
  ...(model.numCtxCap === null ? {} : { maxInputTokens: model.numCtxCap }),
  ...(attempt.maxOutputTokens === undefined ? {} : { maxOutputTokens: attempt.maxOutputTokens }),
  model: attempt.modelName,
  provider: 'local_device',
  source: 'live' as const,
  structuredOutputMode: knownCapabilities(model).includes('json_schema') ? 'native-json' as const : 'text-only' as const,
  supportsChat: true,
  supportsEmbeddings: false,
  supportsModelDiscovery: true,
  supportsStreaming: true,
  supportsVision: false,
  systemPromptMode: 'native' as const,
  toolCallingMode: knownCapabilities(model).includes('tools') ? 'native' as const : 'disabled' as const,
  toolResultMode: 'native-tool-message' as const,
  usageReporting: {
    cachedInputTokens: false,
    cachedOutputTokens: false,
    cacheReadTokens: false,
    cacheWriteTokens: false,
    inputTokens: true,
    outputTokens: true,
    providerReportedCost: false,
  },
})

const errorResult = (
  attempt: LocalInferenceAttemptRequest,
  model: EligibleModel,
  now: Date,
): LocalInferenceResult => ({
  capability: capabilityFor(attempt, model, now),
  content: null,
  finishReason: 'error',
  modelDigest: attempt.modelDigest,
  remoteHost: null,
  remoteModel: null,
  toolCalls: [],
  usage: { inputTokens: null, outputTokens: null },
})

/**
 * A single-host relay loop. Nothing in its public surface permits a model to
 * select a URL, header, command or a different local model. The pairing/native
 * layer supplies its already-authorized identity and protected receipt journal.
 */
export class LocalInferenceHostLoop {
  #active = new Map<string, AbortController>()
  #frameSequences = new Map<string, number>()
  #polling = false
  #sequences = new Map<LocalInferenceEnvelopePurpose, number>()

  constructor(private readonly dependencies: {
    api: LocalInferenceDaemonApi
    coordinator: Pick<LocalInferenceCoordinator, 'identity' | 'control' | 'syncControl' | 'healthReason' | 'acquire' | 'flushTerminations'>
    fetchImpl?: OllamaFetch
    identity: LocalInferenceHostIdentity
    isPaused: () => boolean
    journal: EncryptedLocalInferenceReceiptJournal
    controlIntervalMs?: number
    now?: () => Date
    origin: string
  }) {}

  async heartbeat(): Promise<void> {
    await this.syncResource()
    const now = this.now()
    const inventory = await observeOllamaInventory(this.dependencies.origin, this.dependencies.fetchImpl)
    const heartbeat = {
      inventory: inventory.models.map((model) => publishedModel(model, now.toISOString())),
      paused: this.dependencies.isPaused() || (await this.dependencies.coordinator.control()).paused,
    }
    await this.dependencies.api.heartbeat({ envelope: this.envelope('heartbeat', heartbeat), heartbeat })
  }

  async pollOnce(): Promise<LocalInferencePollOutcome> {
    if (this.#polling || this.dependencies.isPaused()) return { kind: 'idle' }
    this.#polling = true
    let slot: LocalInferenceCoordinatorLease | null = null
    let bound = false
    let ran = false
    try {
      let pending: JournalResultReceipt[]
      try { pending = await this.dependencies.journal.pending() }
      catch (error) {
        if (error instanceof LocalInferenceReceiptError) return { kind: 'refused', reason: 'protected_storage_unavailable' }
        throw error
      }
      for (const receipt of pending) await this.submitReceipt(receipt)
      if (pending[0]) return { attemptId: pending[0].attemptId, kind: 'completed' }
      await this.flushTerminations()
      slot = await this.dependencies.coordinator.acquire()
      if (!slot) return { kind: 'idle' }
      const poll = {} as Record<string, never>
      const lease = await this.dependencies.api.poll({ envelope: this.envelope('poll', poll), poll })
      if (lease.attempt === null || lease.dispatchFence === null || !lease.admission) return { kind: 'idle' }
      await slot.bind({
        ...LocalInferenceResourceAdmissionSchema.parse(lease.admission), attemptId: lease.attempt.attemptId,
      })
      bound = true
      if (!Number.isSafeInteger(lease.dispatchFence) || lease.dispatchFence < 1) return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      if (!this.isCurrentLease(lease.attempt)) return { attemptId: lease.attempt.attemptId, kind: 'fenced' }
      if (deadlinePassed(lease.attempt, this.now())) return { attemptId: lease.attempt.attemptId, kind: 'fenced' }

      const journalReceipt = { attemptId: lease.attempt.attemptId, dispatchFence: lease.dispatchFence }
      let recovered: JournalResultReceipt | undefined
      try {
        recovered = await this.dependencies.journal.get(journalReceipt)
      } catch (error) {
        if (error instanceof LocalInferenceReceiptError) {
          return { kind: 'refused', reason: 'protected_storage_unavailable' }
        }
        throw error
      }
      if (recovered !== undefined) {
        await this.submitReceipt(recovered)
        return { attemptId: lease.attempt.attemptId, kind: 'completed' }
      }
      ran = true
      return await this.run(lease.attempt, lease.dispatchFence, slot)
    } finally {
      try {
        if (slot && !bound) await slot.releaseIdle()
        if (slot && bound && !ran) await slot.finish(true)
        await this.flushTerminations()
      } finally { this.#polling = false }
    }
  }

  cancel(attemptId: string): void {
    this.#active.get(attemptId)?.abort('cancelled')
  }

  /** Stop every in-flight local request when this host loses its authority. */
  stop(): void {
    for (const controller of this.#active.values()) controller.abort('host_stopped')
  }

  private async run(
    attempt: LocalInferenceAttemptRequest, dispatchFence: number, slot: LocalInferenceCoordinatorLease,
  ): Promise<LocalInferencePollOutcome> {
    let invoked = false
    let confirmed = false
    const controller = new AbortController()
    this.#active.set(attempt.attemptId, controller)
    this.#frameSequences.set(attempt.attemptId, 1)
    const remainingMs = new Date(attempt.deadlineAt).valueOf() - this.now().valueOf()
    const deadlineTimer = setTimeout(() => controller.abort('deadline_exceeded'), Math.max(1, remainingMs))
    let controlPending = false
    const controlTimer = setInterval(() => {
      if (controlPending || controller.signal.aborted) return
      controlPending = true
      const control = { attemptId: attempt.attemptId, dispatchFence }
      void this.dependencies.api.control({ envelope: this.envelope('control', control), control })
        .then((response) => {
          if (response.state !== 'active') controller.abort(response.state)
        })
        .catch(() => undefined)
        .finally(() => { controlPending = false })
    }, this.dependencies.controlIntervalMs ?? CONTROL_POLL_INTERVAL_MS)
    let model: EligibleModel | undefined
    try {
      model = await this.selectedModel(attempt)
      if (model === undefined || (attempt.tools.length > 0 && !knownCapabilities(model).includes('tools'))) {
        await this.submitErrorFrame(attempt, dispatchFence, model === undefined ? 'model_missing' : 'unsupported_capability')
        return { attemptId: attempt.attemptId, kind: 'fenced' }
      }
      if (model.numCtxCap !== null && attempt.numCtx > model.numCtxCap) {
        await this.submitErrorFrame(attempt, dispatchFence, 'context_too_large')
        return { attemptId: attempt.attemptId, kind: 'fenced' }
      }

      invoked = true
      const result = await this.invoke(attempt, dispatchFence, model, controller.signal)
      await slot.finish(true)
      confirmed = true
      // A second observation catches a selected tag changing while Ollama was
      // generating. A terminal result is never accepted on that stale digest.
      if (await this.selectedModel(attempt) === undefined) return { attemptId: attempt.attemptId, kind: 'fenced' }
      const receipt = { attemptId: attempt.attemptId, dispatchFence, result }
      await this.dependencies.journal.record(receipt)
      await this.submitReceipt(receipt)
      return { attemptId: attempt.attemptId, kind: 'completed' }
    } catch (error) {
      if (model === undefined) return { attemptId: attempt.attemptId, kind: 'fenced' }
      const code = error instanceof OllamaChatError ? error.code : 'ollama_unreachable'
      await this.submitErrorFrame(attempt, dispatchFence, code).catch(() => undefined)
      const receipt = { attemptId: attempt.attemptId, dispatchFence, result: errorResult(attempt, model, this.now()) }
      try {
        await this.dependencies.journal.record(receipt)
        await this.submitReceipt(receipt)
      } catch {
        // The receipt remains in protected storage for a duplicate lease. No
        // retry here can rerun a model call whose outcome is already ambiguous.
      }
      return { attemptId: attempt.attemptId, kind: 'completed' }
    } finally {
      clearTimeout(deadlineTimer)
      clearInterval(controlTimer)
      this.#active.delete(attempt.attemptId)
      this.#frameSequences.delete(attempt.attemptId)
      if (!confirmed) await slot.finish(!invoked)
    }
  }

  private async invoke(
    attempt: LocalInferenceAttemptRequest,
    dispatchFence: number,
    model: EligibleModel,
    signal: AbortSignal,
  ): Promise<LocalInferenceResult> {
    let content = ''
    let finishReason: LocalInferenceResult['finishReason'] = 'other'
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let toolCalls: LocalInferenceResult['toolCalls'] = []
    for await (const event of streamOllamaChat({
      attempt, fetchImpl: this.dependencies.fetchImpl, origin: this.dependencies.origin, signal,
    })) {
      if (event.text !== undefined) {
        if (Buffer.byteLength(content + event.text, 'utf8') > MAX_OUTPUT_BYTES) {
          throw new OllamaChatError('protocol_error')
        }
        content += event.text
        for (const frameText of splitFrames(event.text)) {
          const frame = {
            attemptId: attempt.attemptId,
            data: frameData(frameText),
            dispatchFence,
            sequence: this.nextFrameSequence(attempt.attemptId),
          }
          await this.dependencies.api.submitFrame({ envelope: this.envelope('frames', frame), frame })
        }
      }
      if (event.toolCalls !== undefined) toolCalls = event.toolCalls
      if (event.done) {
        finishReason = event.finishReason ?? 'other'
        inputTokens = event.inputTokens ?? null
        outputTokens = event.outputTokens ?? null
      }
    }
    return {
      capability: capabilityFor(attempt, model, this.now()),
      content: content || null,
      finishReason,
      modelDigest: attempt.modelDigest,
      remoteHost: null,
      remoteModel: null,
      toolCalls,
      usage: { inputTokens, outputTokens },
    }
  }

  private async submitErrorFrame(
    attempt: LocalInferenceAttemptRequest,
    dispatchFence: number,
    code: string,
  ): Promise<void> {
    const frame = {
      attemptId: attempt.attemptId,
      data: Buffer.from(JSON.stringify({ message: code, retryable: false, type: 'response.error' })).toString('base64url'),
      dispatchFence,
      sequence: this.nextFrameSequence(attempt.attemptId),
    }
    await this.dependencies.api.submitFrame({ envelope: this.envelope('frames', frame), frame })
  }

  private async submitReceipt(receipt: JournalResultReceipt): Promise<void> {
    const apiReceipt: ApiResultReceipt = receipt
    try {
      await this.dependencies.api.submitResult({ envelope: this.envelope('result', apiReceipt), receipt: apiReceipt })
    } catch (error) {
      // A current signed host may learn that an expired/fenced result can no
      // longer be accepted; discard that receipt without re-running its model.
      if (!(error instanceof LocalInferenceApiError) || error.code !== 'LOCAL_ATTEMPT_FENCED') throw error
    }
    await this.dependencies.journal.acknowledge(receipt)
  }

  async syncResource(action?: 'pause' | 'resume'): Promise<void> {
    const coordinator = this.dependencies.coordinator
    const current = await coordinator.control()
    const requestedAction = action ?? current.pendingAction ?? undefined
    const attachment = {
      connectionEpoch: this.dependencies.identity.connectionEpoch, hostId: this.dependencies.identity.hostId,
      organizationId: this.dependencies.identity.organizationId, publicKey: coordinator.identity.publicKey,
    }
    const resource = {
      attachment: {
        ...attachment, signature: signLocalInferenceResourceAttachment(attachment, coordinator.identity.privateKey),
      },
      controlRevision: current.controlRevision, healthReason: await coordinator.healthReason(), paused: current.paused,
      ...(requestedAction ? { action: requestedAction } : {}),
    }
    const control = await this.dependencies.api.attachResource({ envelope: this.envelope('resource', resource), resource })
    await coordinator.syncControl(LocalInferenceResourceControlSchema.parse(control), requestedAction)
    await this.flushTerminations()
  }

  private async flushTerminations(): Promise<void> {
    await this.dependencies.coordinator.flushTerminations(async (termination) => {
      await this.dependencies.api.terminateAttempt({ envelope: this.envelope('termination', termination), termination })
    })
  }

  private async selectedModel(attempt: LocalInferenceAttemptRequest): Promise<EligibleModel | undefined> {
    const inventory = await observeOllamaInventory(this.dependencies.origin, this.dependencies.fetchImpl)
    return inventory.models.find((model) => matchesSelectedModel(model, attempt))
  }

  private envelope(purpose: LocalInferenceEnvelopePurpose, body: unknown) {
    const next = (this.#sequences.get(purpose) ?? 0) + 1
    this.#sequences.set(purpose, next)
    return signLocalInferenceEnvelope({
      body,
      header: {
        connectionEpoch: this.dependencies.identity.connectionEpoch,
        ...(this.dependencies.identity.executorConnectionEpoch === undefined
          ? {}
          : { executorConnectionEpoch: this.dependencies.identity.executorConnectionEpoch }),
        hostId: this.dependencies.identity.hostId,
        organizationId: this.dependencies.identity.organizationId,
        protocolVersion: LOCAL_INFERENCE_PROTOCOL_VERSION,
        purpose,
        sentAt: this.now().toISOString(),
        sequence: next,
      },
      machinePrivateKey: this.dependencies.identity.machinePrivateKey,
    })
  }

  private isCurrentLease(attempt: LocalInferenceAttemptRequest): boolean {
    try {
      return attempt.hostId === this.dependencies.identity.hostId
        && BigInt(attempt.hostEpoch) === BigInt(this.dependencies.identity.connectionEpoch)
    } catch {
      return false
    }
  }

  private nextFrameSequence(attemptId: string): number {
    const next = this.#frameSequences.get(attemptId)
    if (next === undefined) throw new Error('No active local inference frame sequence.')
    this.#frameSequences.set(attemptId, next + 1)
    return next
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }
}
