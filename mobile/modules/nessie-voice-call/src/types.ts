/**
 * The JS view of a native Personal Assistant call.
 *
 * Everything with a lifecycle — the CallKit call, the Gemini socket, the
 * microphone, credential rotation, the transcript — lives natively, because a
 * locked phone has no JavaScript running. This surface only starts a call,
 * ends it, and reports what the native side is doing.
 */

export type NativeVoiceCallPhase =
  | 'idle'
  | 'connecting'
  | 'live'
  /** A system call (or another app) took the audio; ours is paused. */
  | 'held'
  | 'ending'
  | 'failed'

export type NativeVoiceCallState = {
  phase: NativeVoiceCallPhase
  muted: boolean
  /** Present only in `failed`, and already written for a person to read. */
  error: string | null
  agentName: string | null
  /** Epoch milliseconds, set once audio is flowing, for the call timer. */
  startedAt: number | null
  /** What the assistant is saying right now, for a live ticker. */
  liveAssistantText: string
  assistantSpeaking: boolean
}

/**
 * What the WebView hands the native side to place a call.
 *
 * This is the *initial provisioning path only*: the SPA mints the voice-scoped
 * device credential on its ordinary session and passes it across the bridge
 * once. From then on the native side renews it against
 * `POST /api/voice/device-token/refresh`, because a locked phone has no
 * foreground WebView to ask.
 */
export type NativeVoiceCallProvisioning = {
  /** Absolute origin of the Nessie API — the WebView's own origin is not it. */
  apiBaseUrl: string
  /** The `nvc1_`-prefixed voice-scoped device credential. */
  token: string
  /** ISO-8601. */
  tokenExpiresAt: string
  /** ISO-8601; when the native side should start renewing, not when it must. */
  refreshAfter: string
  installationId: string
  /** For the CallKit handle, so the lock screen names the assistant. */
  agentName: string
}

export type NativeVoiceCallStateEvent = {
  state: NativeVoiceCallState
}

export const IDLE_NATIVE_VOICE_CALL_STATE: NativeVoiceCallState = {
  phase: 'idle',
  muted: false,
  error: null,
  agentName: null,
  startedAt: null,
  liveAssistantText: '',
  assistantSpeaking: false,
}
