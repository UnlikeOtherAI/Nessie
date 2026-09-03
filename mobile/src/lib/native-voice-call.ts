import type { NativeVoiceCallProvisioning, NativeVoiceCallState } from '../../modules/nessie-voice-call'
import type { NativeShellMessage } from './native-shell-message'

/**
 * The WebView half of a native Personal Assistant call.
 *
 * The admin owns the button and the in-call surface; the native side owns the
 * call. Two messages cross in one direction (start, and the two in-call
 * controls) and one event crosses back — deliberately small, because everything
 * that must survive a locked screen or a JS reload lives natively.
 */

export const NATIVE_VOICE_CALL_STATE_EVENT = 'nessie:native-voice-call-state'

export type VoiceCallStartMessage = NativeShellMessage & {
  type: 'nessie:voice-call-start'
  voiceCall: NativeVoiceCallProvisioning
}

export type VoiceCallControlMessage = NativeShellMessage & {
  type: 'nessie:voice-call-end' | 'nessie:voice-call-mute'
  muted?: boolean
}

const isProvisioning = (value: unknown): value is NativeVoiceCallProvisioning => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['apiBaseUrl'] === 'string'
    && typeof candidate['token'] === 'string'
    && typeof candidate['tokenExpiresAt'] === 'string'
    && typeof candidate['refreshAfter'] === 'string'
    && typeof candidate['installationId'] === 'string'
    && typeof candidate['agentName'] === 'string'
}

export const isVoiceCallStartMessage = (
  message: NativeShellMessage,
): message is VoiceCallStartMessage =>
  message.type === 'nessie:voice-call-start' && isProvisioning(message.voiceCall)

export const isVoiceCallControlMessage = (
  message: NativeShellMessage,
): message is VoiceCallControlMessage =>
  message.type === 'nessie:voice-call-end' || message.type === 'nessie:voice-call-mute'

/**
 * Publishes native call state into the page.
 *
 * A `CustomEvent` rather than a global the admin polls: the call changes state
 * from CallKit, from the lock screen, and from a cellular call arriving — none
 * of which the page can observe on its own.
 */
export const nativeVoiceCallStateScript = (state: NativeVoiceCallState): string => `
try {
  window.__nessieNativeVoiceCallState = ${JSON.stringify(state)};
  window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_VOICE_CALL_STATE_EVENT)}, {
    detail: ${JSON.stringify(state)},
  }));
} catch (e) {}
`
