import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { VoiceCapability } from '@nessie/schemas'

import { voiceKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { createVoiceApi } from './voice-api'
import { createVoiceCall, type VoiceCall, type VoiceCallState } from './voice-call-client'
import { drainUsageOutbox } from './voice-usage-outbox'

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

  const api = useMemo(() => createVoiceApi(apiClient), [apiClient])

  const ensureCall = useCallback((): VoiceCall => {
    if (!callRef.current) {
      callRef.current = createVoiceCall({ api, onState: setState })
    }
    return callRef.current
  }, [api])

  useEffect(
    () => () => {
      callRef.current?.dispose()
      callRef.current = null
    },
    [],
  )

  /**
   * Replays usage reports a previous visit could not deliver.
   *
   * A tab closed mid-call leaves spend nobody can attribute; this is the one
   * chance to hand it over, so it runs on mount rather than at the next call.
   */
  useEffect(() => {
    void drainUsageOutbox({
      send: (report) => api.reportUsage(report).then(() => undefined),
    }).catch(() => undefined)
  }, [api])

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
