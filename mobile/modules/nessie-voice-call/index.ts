import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core'

import {
  IDLE_NATIVE_VOICE_CALL_STATE,
  type NativeVoiceCallProvisioning,
  type NativeVoiceCallState,
  type NativeVoiceCallStateEvent,
} from './src/types'

export {
  IDLE_NATIVE_VOICE_CALL_STATE,
  type NativeVoiceCallPhase,
  type NativeVoiceCallProvisioning,
  type NativeVoiceCallState,
  type NativeVoiceCallStateEvent,
} from './src/types'

/**
 * A CallKit-backed call with the Personal Assistant.
 *
 * The module is iOS-only today. `requireOptionalNativeModule` rather than
 * `requireNativeModule` is what makes "unavailable" a state the shell can read
 * instead of a crash on Android, in Expo Go, or in a build that predates the
 * module — the header call button must be able to ask before it offers.
 */

type NessieVoiceCallNativeModule = {
  startCall: (provisioning: NativeVoiceCallProvisioning) => Promise<void>
  endCall: () => Promise<void>
  setMuted: (muted: boolean) => Promise<void>
  getActiveCallState: () => NativeVoiceCallState
  addListener: (
    event: 'onCallState',
    listener: (payload: NativeVoiceCallStateEvent) => void,
  ) => EventSubscription
}

const nativeModule = requireOptionalNativeModule<NessieVoiceCallNativeModule>('NessieVoiceCall')

/** Whether this build can place a native call at all. */
export const isNativeVoiceCallAvailable = (): boolean => nativeModule !== null

export const startNativeVoiceCall = async (
  provisioning: NativeVoiceCallProvisioning,
): Promise<void> => {
  if (!nativeModule) throw new Error('Native calling is not available in this build.')
  await nativeModule.startCall(provisioning)
}

export const endNativeVoiceCall = async (): Promise<void> => {
  await nativeModule?.endCall()
}

export const setNativeVoiceCallMuted = async (muted: boolean): Promise<void> => {
  await nativeModule?.setMuted(muted)
}

/**
 * The call's state right now, asked rather than awaited.
 *
 * The call is native and survives a JS reload; the event stream does not. Without
 * this the shell would remount blind — a call running with no UI saying so, and
 * no way to hang up short of the lock screen.
 */
export const getActiveNativeVoiceCallState = (): NativeVoiceCallState =>
  nativeModule?.getActiveCallState() ?? IDLE_NATIVE_VOICE_CALL_STATE

export const addNativeVoiceCallStateListener = (
  listener: (state: NativeVoiceCallState) => void,
): EventSubscription | null =>
  nativeModule?.addListener('onCallState', (payload) => listener(payload.state)) ?? null
