import { useEffect, useState } from 'react'

import type { VoiceCallState } from './voice-call-client'

/**
 * The same call, placed by the phone instead of the browser.
 *
 * On a phone the header call button hands off to the native module, which
 * places a real CallKit call: it rings, it appears on the lock screen, it
 * survives the app going away, and it routes to AirPods and CarPlay like any
 * other call. The SPA's only jobs are minting the device credential once and
 * rendering what the native side reports.
 */

const NATIVE_VOICE_CALL_STATE_EVENT = 'nessie:native-voice-call-state'

export type NativeVoiceCallPhase = VoiceCallState['phase']

type NativeVoiceCallState = {
  phase: NativeVoiceCallPhase
  muted: boolean
  error: string | null
  agentName: string | null
  startedAt: number | null
  liveAssistantText: string
  assistantSpeaking: boolean
}

type NativeVoiceWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
  __nessieNativeShell?: { voiceCall?: boolean }
  __nessieNativeVoiceCallState?: NativeVoiceCallState
}

const IDLE: NativeVoiceCallState = {
  phase: 'idle',
  muted: false,
  error: null,
  agentName: null,
  startedAt: null,
  liveAssistantText: '',
  assistantSpeaking: false,
}

/**
 * Whether this shell can place a native call.
 *
 * Both halves must hold: the page is inside the mobile shell, *and* that build
 * carries the calling module. An installed build predating the module has the
 * same header button, so asking the shell rather than assuming is what keeps it
 * working there instead of failing into nothing.
 */
export const isNativeVoiceCallShell = (): boolean => {
  if (typeof window === 'undefined') return false
  const shell = window as NativeVoiceWindow
  return 'ReactNativeWebView' in shell && shell.__nessieNativeShell?.voiceCall === true
}

const post = (message: Record<string, unknown>): void => {
  if (typeof window === 'undefined') return
  ;(window as NativeVoiceWindow).ReactNativeWebView?.postMessage(JSON.stringify(message))
}

export type NativeVoiceCallProvisioning = {
  apiBaseUrl: string
  token: string
  tokenExpiresAt: string
  refreshAfter: string
  installationId: string
  agentName: string
}

export const handOffCallToNative = (provisioning: NativeVoiceCallProvisioning): void => {
  post({ type: 'nessie:voice-call-start', voiceCall: provisioning })
}

export const endNativeCall = (): void => {
  post({ type: 'nessie:voice-call-end' })
}

export const setNativeCallMuted = (muted: boolean): void => {
  post({ type: 'nessie:voice-call-mute', muted })
}

/**
 * Mirrors the native call's state into React.
 *
 * Seeded from the global the shell writes alongside each event, not only from
 * the events: a reload remounts this hook mid-call, and the first event after
 * that could be minutes away.
 */
export const useNativeVoiceCallState = (): NativeVoiceCallState => {
  const [state, setState] = useState<NativeVoiceCallState>(
    () => (typeof window === 'undefined'
      ? IDLE
      : (window as NativeVoiceWindow).__nessieNativeVoiceCallState ?? IDLE),
  )

  useEffect(() => {
    const onState = (event: Event): void => {
      const detail = (event as CustomEvent<NativeVoiceCallState>).detail
      if (detail) setState(detail)
    }
    window.addEventListener(NATIVE_VOICE_CALL_STATE_EVENT, onState)
    setState((window as NativeVoiceWindow).__nessieNativeVoiceCallState ?? IDLE)
    return () => window.removeEventListener(NATIVE_VOICE_CALL_STATE_EVENT, onState)
  }, [])

  return state
}

/**
 * The native call, rendered through the one in-call surface.
 *
 * A second dialog for the phone would be the fork Rule zero names, so the
 * native state is adapted into the shape `VoiceCallDialog` already reads. The
 * transcript stays empty on purpose: the native side holds it for the record,
 * and the phone's in-call surface is CallKit's, not this dialog's.
 */
export const asVoiceCallState = (native: NativeVoiceCallState): VoiceCallState => ({
  phase: native.phase,
  muted: native.muted,
  error: native.error,
  transcript: [],
  liveUserText: '',
  liveAssistantText: native.liveAssistantText,
  assistantSpeaking: native.assistantSpeaking,
  startedAt: native.startedAt,
  agentName: native.agentName,
})
