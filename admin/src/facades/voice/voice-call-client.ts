import type { VoiceSessionCredential, VoiceTranscriptLine } from '@nessie/schemas'

import {
  buildAudioPayload,
  buildSeedPayload,
  buildSetupPayload,
  buildTextPayload,
  buildToolResponsePayload,
  parseServerFrame,
  type GeminiServerEvent,
  type GeminiToolCall,
} from './gemini-live-protocol'
import {
  createVoicePlayback,
  decodePcmChunk,
  encodePcmFrame,
  startVoiceCapture,
  type VoiceCapture,
  type VoicePlayback,
} from './voice-audio'
import type { VoiceApi } from './voice-api'
import {
  clearTranscript,
  drainUsageOutbox,
  enqueueUsageReport,
  stashTranscript,
} from './voice-usage-outbox'
import { collectTranscript, type TranscriptCollector } from './voice-transcript-collector'
import { createAssistantHandoff, type AssistantHandoff } from './voice-assistant-handoff'

/**
 * One voice call, from the button press to the durable record.
 *
 * The controller owns the Gemini socket, the microphone, and the call's own
 * lifecycle. Everything with authority — the credential, tool execution, the
 * record — happens server-side; this file only carries bytes and state.
 */

export type VoiceCallPhase = 'idle' | 'connecting' | 'live' | 'ending' | 'failed'

export type VoiceCallState = {
  phase: VoiceCallPhase
  muted: boolean
  error: string | null
  /** Finalised lines, oldest first. */
  transcript: VoiceTranscriptLine[]
  /** What the person is saying right now, before it finalises. */
  liveUserText: string
  /** What the assistant is saying right now. */
  liveAssistantText: string
  assistantSpeaking: boolean
  /** Set once audio is flowing, for the call timer. */
  startedAt: number | null
  agentName: string | null
}

const IDLE_STATE: VoiceCallState = {
  phase: 'idle',
  muted: false,
  error: null,
  transcript: [],
  liveUserText: '',
  liveAssistantText: '',
  assistantSpeaking: false,
  startedAt: null,
  agentName: null,
}

/** Rotate a minute early, leaving room for a retry before the credential dies. */
const ROTATE_LEAD_MS = 60_000

export type VoiceCall = {
  start: () => Promise<void>
  end: () => Promise<void>
  setMuted: (muted: boolean) => void
  getState: () => VoiceCallState
  dispose: () => void
}

export const createVoiceCall = (deps: {
  api: VoiceApi
  onState: (state: VoiceCallState) => void
}): VoiceCall => {
  let state: VoiceCallState = { ...IDLE_STATE }
  let socket: WebSocket | null = null
  let capture: VoiceCapture | null = null
  let playback: VoicePlayback | null = null
  let credential: VoiceSessionCredential | null = null
  let resumptionHandle: string | null = null
  let rotateTimer: ReturnType<typeof setTimeout> | null = null
  let usageSequence = 0
  let disposed = false
  let collector: TranscriptCollector = collectTranscript()
  let handoff: AssistantHandoff | null = null

  const publish = (patch: Partial<VoiceCallState>): void => {
    state = { ...state, ...patch }
    deps.onState(state)
  }

  const send = (payload: Record<string, unknown>): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  /**
   * Speaks a line the app produced rather than the person.
   *
   * Used to deliver an assistant reply that arrived after a hand-off; the
   * model reads it out in its own voice instead of the page interrupting with
   * synthetic speech.
   */
  const speakThroughModel = (text: string): void => {
    send(buildTextPayload(text))
  }

  const failCall = (message: string): void => {
    publish({ phase: 'failed', error: message })
    void teardown()
  }

  const handleToolCall = async (call: GeminiToolCall): Promise<unknown> => {
    if (call.name !== 'pa_send' || !handoff) {
      return { ok: false, error: `Unknown tool: ${call.name}` }
    }
    const text = typeof call.args['text'] === 'string' ? call.args['text'] : ''
    if (text.trim().length === 0) return { ok: false, error: 'No request text was provided.' }
    return handoff.dispatch(text)
  }

  const handleEvent = (event: GeminiServerEvent): void => {
    switch (event.kind) {
      case 'setup-complete': {
        // Seed only on the first connect: a resumed session already holds the
        // conversation, and re-seeding would duplicate it into the context
        // Gemini re-bills on every turn.
        if (!resumptionHandle && credential && credential.seedTurns.length > 0) {
          send(buildSeedPayload(credential.seedTurns))
        }
        publish({ phase: 'live', startedAt: state.startedAt ?? Date.now() })
        break
      }
      case 'audio': {
        playback?.enqueue(decodePcmChunk(event.base64))
        if (!state.assistantSpeaking) publish({ assistantSpeaking: true })
        break
      }
      case 'user-transcript': {
        collector.appendUser(event.text)
        publish({ liveUserText: collector.liveUserText() })
        break
      }
      case 'assistant-transcript': {
        collector.appendAssistant(event.text)
        publish({ liveAssistantText: collector.liveAssistantText() })
        break
      }
      case 'turn-complete': {
        collector.finalise(Date.now())
        stashCurrentTranscript()
        publish({
          transcript: collector.lines(),
          liveUserText: '',
          liveAssistantText: '',
          assistantSpeaking: false,
        })
        break
      }
      case 'interrupted': {
        // The person talked over the model: drop what is already scheduled,
        // or it keeps talking for however much audio was buffered ahead.
        playback?.flush()
        collector.finalise(Date.now())
        publish({
          transcript: collector.lines(),
          liveAssistantText: '',
          assistantSpeaking: false,
        })
        break
      }
      case 'tool-calls': {
        for (const call of event.calls) {
          // Never await inside the socket handler: a hand-off does a network
          // round trip, and blocking here would stall incoming audio.
          void handleToolCall(call).then((result) => {
            send(buildToolResponsePayload([{ id: call.id, name: call.name, result }]))
          })
        }
        break
      }
      case 'resumption-handle': {
        resumptionHandle = event.handle
        break
      }
      case 'go-away': {
        // Google is rotating this socket. Reconnect on the same credential.
        void reconnect()
        break
      }
      case 'usage': {
        recordUsage(event.metadata)
        break
      }
    }
  }

  /**
   * Snapshots the transcript so far.
   *
   * The lines exist only on this device, so a tab that dies mid-call is the
   * one case where the record is unrecoverable. Written at each turn boundary
   * and cleared once the server has it.
   */
  const stashCurrentTranscript = (): void => {
    if (!credential || !state.startedAt) return
    const lines = collector.lines()
    if (lines.length === 0) return
    stashTranscript({
      voiceSessionId: credential.voiceSessionId,
      lines,
      durationMs: Date.now() - state.startedAt,
    })
  }

  const recordUsage = (metadata: Record<string, unknown>): void => {
    if (!credential) return
    usageSequence += 1
    enqueueUsageReport({
      voiceSessionId: credential.voiceSessionId,
      sequence: usageSequence,
      model: credential.model,
      usage: normaliseUsage(metadata),
      complete: false,
    })
    void drainUsageOutbox({ send: (report) => deps.api.reportUsage(report).then(() => undefined) })
  }

  const openSocket = (accessToken: string, websocketUrl: string): Promise<void> =>
    new Promise((resolve, reject) => {
      // A browser cannot set request headers on a WebSocket, so the ephemeral
      // credential travels in the query string. It must be `access_token`,
      // not `key`: an ephemeral `auth_tokens/…` credential is not an API key,
      // and Google closes a `?key=` socket with 1007 "Obtain one from
      // CreateAuthToken and pass it in an `access_token` query param".
      // Verified against the live service, which is the only place the
      // difference shows.
      const url = `${websocketUrl}?access_token=${encodeURIComponent(accessToken)}`
      const next = new WebSocket(url)
      // Gemini Live answers in BINARY frames, so `message.data` would arrive
      // as a Blob and every frame would die in the parser's catch — the socket
      // opens, setup is sent, `setupComplete` comes back, and the client
      // ignores all of it with no error anywhere. Node's `ws` hides this
      // because a Buffer stringifies, which is why probes passed while the
      // browser could never work. ArrayBuffer decodes synchronously; a Blob
      // would need an await inside the frame handler.
      next.binaryType = 'arraybuffer'
      socket = next
      let settled = false

      next.onopen = () => {
        if (!credential) return
        send(
          buildSetupPayload({
            model: credential.model,
            voiceName: credential.voiceName,
            systemInstruction: credential.systemInstruction,
            functionDeclarations: credential.functionDeclarations,
            ...(resumptionHandle ? { sessionResumptionHandle: resumptionHandle } : {}),
          }),
        )
        settled = true
        resolve()
      }
      next.onmessage = (message: MessageEvent<ArrayBuffer | string>) => {
        const raw =
          typeof message.data === 'string'
            ? message.data
            : new TextDecoder().decode(message.data)
        for (const event of parseServerFrame(raw)) handleEvent(event)
      }
      next.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('Could not reach the voice service.'))
        }
      }
      next.onclose = () => {
        if (socket !== next) return
        if (!settled) {
          settled = true
          reject(new Error('The voice connection closed before it opened.'))
          return
        }
        // A close during a live call is recoverable only while the credential
        // is still valid and Gemini gave us a handle to resume with. A close
        // while still connecting is not recoverable and must say so — leaving
        // the dialog on "Connecting…" forever is how the binary-frame bug
        // presented, and an honest failure would have named it immediately.
        if (state.phase === 'live') {
          void reconnect()
        } else if (state.phase === 'connecting') {
          failCall('The voice service closed the connection during setup.')
        }
      }
    })

  /** Re-opens the socket on the current credential, resuming the conversation. */
  const reconnect = async (): Promise<void> => {
    if (disposed || !credential || state.phase === 'ending') return
    if (Date.parse(credential.expiresAt) - Date.now() < 5_000) {
      await rotate()
      return
    }
    try {
      await openSocket(credential.accessToken, credential.websocketUrl)
    } catch {
      failCall('The call dropped and could not reconnect.')
    }
  }

  /**
   * Swaps in a fresh credential without ending the call.
   *
   * The voice session id survives, so the usage stream and the transcript slot
   * stay attached to this one call; only Google's 30-minute credential moves.
   */
  const rotate = async (): Promise<void> => {
    if (disposed || !credential || state.phase !== 'live') return
    try {
      const rotated = await deps.api.rotateSession(credential.voiceSessionId)
      credential = { ...credential, ...rotated }
      await openSocket(rotated.accessToken, rotated.websocketUrl)
      scheduleRotation()
    } catch {
      failCall('The call reached its limit and ended.')
    }
  }

  const scheduleRotation = (): void => {
    if (rotateTimer) clearTimeout(rotateTimer)
    if (!credential) return
    const delay = Math.max(5_000, Date.parse(credential.expiresAt) - Date.now() - ROTATE_LEAD_MS)
    rotateTimer = setTimeout(() => void rotate(), delay)
  }

  const teardown = async (): Promise<void> => {
    if (rotateTimer) {
      clearTimeout(rotateTimer)
      rotateTimer = null
    }
    handoff?.stop()
    handoff = null
    const closing = socket
    socket = null
    closing?.close()
    await capture?.stop()
    capture = null
    await playback?.stop()
    playback = null
  }

  return {
    getState: () => state,

    start: async () => {
      if (state.phase !== 'idle' && state.phase !== 'failed') return
      publish({ ...IDLE_STATE, phase: 'connecting' })
      collector = collectTranscript()
      usageSequence = 0
      resumptionHandle = null

      try {
        // Prove the microphone before minting: a credential is one-use and
        // holds a Ledger budget slot, so burning one on a browser that then
        // refuses audio wastes it until it expires.
        playback = createVoicePlayback()
        capture = await startVoiceCapture({
          onFrame: (frame) => send(buildAudioPayload(encodePcmFrame(frame))),
        })

        const installationId = await deps.api.ensureInstallation()
        credential = await deps.api.startSession(installationId)
        publish({ agentName: credential.agentName })
        handoff = createAssistantHandoff({
          api: deps.api,
          threadId: credential.threadId,
          speak: speakThroughModel,
        })

        await openSocket(credential.accessToken, credential.websocketUrl)
        scheduleRotation()
      } catch (error) {
        await teardown()
        publish({
          phase: 'failed',
          error: error instanceof Error ? error.message : 'The call could not be started.',
        })
      }
    },

    end: async () => {
      if (state.phase === 'idle' || state.phase === 'ending') return
      const active = credential
      const startedAt = state.startedAt
      publish({ phase: 'ending' })
      await teardown()

      collector.finalise(Date.now())
      const lines = collector.lines()

      if (active) {
        // The final usage report closes Ledger's session; it is queued rather
        // than fire-and-forget so a failure here replays on the next call
        // instead of losing the call's last turn of spend.
        if (usageSequence > 0) {
          usageSequence += 1
          enqueueUsageReport({
            voiceSessionId: active.voiceSessionId,
            sequence: usageSequence,
            model: active.model,
            usage: null,
            complete: true,
          })
        }
        await drainUsageOutbox({
          send: (report) => deps.api.reportUsage(report).then(() => undefined),
        }).catch(() => undefined)

        try {
          if (lines.length > 0) {
            await deps.api.submitTranscript(
              active.voiceSessionId,
              lines,
              startedAt ? Date.now() - startedAt : 0,
            )
            clearTranscript(active.voiceSessionId)
          } else {
            await deps.api.endSession(active.voiceSessionId)
          }
        } catch {
          // The call is over either way; a missing record is not worth
          // holding the UI in an ending state for.
        }
      }

      credential = null
      publish({ ...IDLE_STATE, transcript: lines })
    },

    setMuted: (muted: boolean) => {
      capture?.setMuted(muted)
      publish({ muted })
    },

    dispose: () => {
      disposed = true
      void teardown()
    },
  }
}

/** Google's usage metadata, mapped onto the shape Ledger stores. */
const normaliseUsage = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const count = (key: string): number => {
    const value = metadata[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const modalities = (key: string): Record<string, number> => {
    const raw = metadata[key]
    if (!Array.isArray(raw)) return {}
    const totals: Record<string, number> = {}
    for (const entry of raw) {
      const item = entry as { modality?: unknown; tokenCount?: unknown }
      if (typeof item?.modality !== 'string') continue
      const tokens = typeof item.tokenCount === 'number' ? item.tokenCount : 0
      totals[item.modality] = (totals[item.modality] ?? 0) + tokens
    }
    return totals
  }

  return {
    promptTokens: count('promptTokenCount'),
    cachedPromptTokens: count('cachedContentTokenCount'),
    responseTokens: count('responseTokenCount'),
    toolUsePromptTokens: count('toolUsePromptTokenCount'),
    thoughtTokens: count('thoughtsTokenCount'),
    totalTokens: count('totalTokenCount'),
    inputModalities: modalities('promptTokensDetails'),
    cachedModalities: modalities('cacheTokensDetails'),
    outputModalities: modalities('responseTokensDetails'),
    toolUsePromptModalities: modalities('toolUsePromptTokensDetails'),
  }
}
