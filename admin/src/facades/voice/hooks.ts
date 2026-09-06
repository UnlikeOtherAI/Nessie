import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { VoiceCapability } from '@nessie/schemas'

import { getBaseUrl } from '../../lib/api-client'
import { threadKeys } from '../threads/keys'
import { voiceKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import {
  asVoiceCallState,
  endNativeCall,
  handOffCallToNative,
  isNativeVoiceCallShell,
  setNativeCallMuted,
  useNativeVoiceCallState,
} from './native-voice-call'
import { createVoiceApi } from './voice-api'
import { createVoiceCall, type VoiceCall, type VoiceCallState } from './voice-call-client'
import { drainTranscriptOutbox, drainUsageOutbox } from './voice-usage-outbox'

/**
 * The admin's handle on a live voice call.
 *
 * One call at a time per tab, owned here rather than in a component, so a
 * re-render never restarts it and unmounting the dialog never drops the line.
 */

const IDLE: VoiceCallState = {
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

/**
 * Whether this deployment can place voice calls at all.
 *
 * Gates the call control so an instance with no Ledger shows nothing rather
 * than a button that always fails. It answers from deployment configuration,
 * so it is stable for the session and cached accordingly.
 */
export const useVoiceCapability = () => {
  const apiClient = useApiClient()
  return useQuery<VoiceCapability>({
    queryKey: voiceKeys.capability,
    queryFn: () => apiClient.get<VoiceCapability>('/api/voice/capability'),
    staleTime: Infinity,
    retry: false,
  })
}

export const useVoiceCall = () => {
  const apiClient = useApiClient()
  const [state, setState] = useState<VoiceCallState>(IDLE)
  const callRef = useRef<VoiceCall | null>(null)
  const queryClient = useQueryClient()

  const api = useMemo(() => createVoiceApi(apiClient), [apiClient])

  const ensureCall = useCallback((): VoiceCall => {
    if (!callRef.current) {
      callRef.current = createVoiceCall({
        api,
        onState: setState,
        // The record is a message like any other; the feed has to be told.
        onRecordWritten: (threadId) => {
          void queryClient.invalidateQueries({ queryKey: threadKeys.messages(threadId) })
        },
      })
    }
    return callRef.current
  }, [api, queryClient])

  useEffect(
    () => () => {
      callRef.current?.dispose()
      callRef.current = null
    },
    [],
  )

  /**
   * Replays what a previous visit could not deliver.
   *
   * A tab closed mid-call leaves both spend nobody can attribute and a call
   * with no record — the transcript existed only on that device. This is the
   * one chance to hand both over, so it runs on mount rather than at the next
   * call.
   */
  useEffect(() => {
    void drainUsageOutbox({
      send: (report) => api.reportUsage(report).then(() => undefined),
    }).catch(() => undefined)
    void drainTranscriptOutbox({
      send: (entry) =>
        api
          .submitTranscript(entry.voiceSessionId, entry.lines, entry.durationMs)
          .then(() => undefined),
    }).catch(() => undefined)
  }, [api, queryClient])

  const start = useCallback(async () => {
    await ensureCall().start()
  }, [ensureCall])

  const end = useCallback(async () => {
    await callRef.current?.end()
  }, [])

  const setMuted = useCallback((muted: boolean) => {
    callRef.current?.setMuted(muted)
  }, [])

  return {
    state,
    start,
    end,
    setMuted,
    isActive: state.phase === 'connecting' || state.phase === 'live' || state.phase === 'ending',
  }
}

/**
 * The Personal Assistant call, placed natively where the shell can.
 *
 * One hook, so the page holds one call object regardless of where the call
 * actually runs: inside the mobile app the button hands off to CallKit and this
 * mirrors what native reports; everywhere else it is the browser call,
 * unchanged. Two hooks would put the branch in the page, and the branch would
 * drift.
 */
export const usePersonalAssistantCall = () => {
  const apiClient = useApiClient()
  const browser = useVoiceCall()
  const nativeState = useNativeVoiceCallState()
  const [handOffError, setHandOffError] = useState<string | null>(null)
  const native = isNativeVoiceCallShell()

  const api = useMemo(() => createVoiceApi(apiClient), [apiClient])

  const startNative = useCallback(async () => {
    setHandOffError(null)
    try {
      const installationId = await api.ensureNativeInstallation('ios', 'iPhone')
      const token = await api.mintDeviceToken(installationId)
      // The API origin, not the page's: the admin is served from `app.` and the
      // API from `api.`, and the native side has no relative base to resolve
      // a path against.
      handOffCallToNative({
        agentName: 'Personal Assistant',
        apiBaseUrl: getBaseUrl() || window.location.origin,
        installationId,
        refreshAfter: token.refreshAfter,
        token: token.token,
        tokenExpiresAt: token.expiresAt,
      })
    } catch (error) {
      setHandOffError(error instanceof Error ? error.message : 'The call could not be started.')
    }
  }, [api])

  const nativeCallState = asVoiceCallState(nativeState)
  const state: VoiceCallState = handOffError
    ? { ...nativeCallState, phase: 'failed', error: handOffError }
    : nativeCallState

  if (!native) return browser

  return {
    end: async (): Promise<void> => endNativeCall(),
    isActive: state.phase !== 'idle' && state.phase !== 'failed',
    setMuted: (muted: boolean): void => setNativeCallMuted(muted),
    start: startNative,
    state,
  }
}
