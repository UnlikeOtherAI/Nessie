import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { useLocation } from 'react-router-dom'
import { useRedirect } from '../navigation/redirect'
import {
  WsEventSchema,
  parseChannelId,
  parseUserId,
  type CallIncomingEvent,
} from '@nessie/schemas'
import { ApiClientError } from '@nessie/client-core'
import { IncomingCallDialog, type IncomingCallPresentation } from '../components/shared/IncomingCallDialog'
import { mapAcceptResponse, isWithinCallQuietHours } from '../facades/calls/call-presentation'
import {
  initialIncomingCallState,
  liveIncomingCalls,
  reduceIncomingCallEvent,
  type IncomingCallEvent,
  type IncomingCallState,
} from '../facades/calls/incoming-call-reducer'
import { CallRealtimeContext } from '../facades/calls/realtime-context'
import { getBaseUrl, type CallRecord } from '../lib/api-client'
import { parseChannelIdFromPath } from '../lib/channel-route'
import { isDesktopApp } from '../lib/desktop'
import { isReactNativeWebView } from '../lib/mobile-shell'
import { openExternalUrl } from '../lib/open-external-url'
import { readSseStream, type SseFrame } from '../lib/sse'
import { classifyStreamResponse, runStreamConnectionLoop, type StreamAttemptOutcome } from '../facades/threads/stream-retry'
import { useApiClient } from './ApiClientProvider'
import { useAuthSession } from './AuthSessionProvider'
import { useFocusMode } from './FocusModeProvider'

type ReducerAction =
  | { type: 'event'; value: Parameters<typeof reduceIncomingCallEvent>[1] }
  | { type: 'reset' }

type PresentedCall = {
  call: CallIncomingEvent
  presentation: Exclude<IncomingCallPresentation, 'ringing'>
}

type CallAcceptResponse = CallRecord & {
  code?: 'CALL_ALREADY_ACCEPTED'
}

const initialReducer = (): IncomingCallState => initialIncomingCallState()

const incomingCallReducer = (state: IncomingCallState, action: ReducerAction): IncomingCallState => {
  if (action.type === 'reset') return initialIncomingCallState()
  return reduceIncomingCallEvent(state, action.value)
}

const parseIncomingCallEvent = (frame: SseFrame): IncomingCallEvent | null => {
  if (!frame.data || !frame.id || !frame.event?.startsWith('call.')) return null
  try {
    const parsed = WsEventSchema.safeParse(JSON.parse(frame.data))
    if (!parsed.success) return null
    if (parsed.data.event === 'call.incoming') {
      return { data: parsed.data.data, event: 'call.incoming' }
    }
    if (parsed.data.event === 'call.invite.updated') {
      return { data: parsed.data.data, event: 'call.invite.updated' }
    }
    if (parsed.data.event === 'call.updated') {
      return { data: parsed.data.data, event: 'call.updated' }
    }
  } catch {
    // One malformed persisted event must not end a user's ring stream.
  }
  return null
}

const asIncomingCall = (call: CallRecord): CallIncomingEvent | null => {
  if (!call.meetingUri || !call.ringExpiresAt) return null
  return {
    callId: call.id,
    caller: {
      avatarUrl: null,
      displayName: call.startedByDisplayName,
      id: parseUserId(call.startedById),
    },
    channelId: parseChannelId(call.channelId),
    channelName: call.channelName,
    expiresAt: call.ringExpiresAt,
    meetingUri: call.meetingUri,
    revision: call.revision,
  }
}

const isLiveInviteFor = (call: CallRecord, userId: string, now: number): boolean =>
  (call.status === 'ringing' || call.status === 'active')
  && Boolean(call.ringExpiresAt && Date.parse(call.ringExpiresAt) > now)
  && call.invites.some((invite) => invite.userId === userId && invite.state === 'ringing')

const useRingtone = (enabled: boolean): void => {
  const contextRef = useRef<AudioContext | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const activate = () => {
      if (contextRef.current) return
      if (!('AudioContext' in window)) return
      const context = new AudioContext()
      contextRef.current = context
      void context.resume().then(
        () => setReady(context.state === 'running'),
        () => setReady(false),
      )
    }
    window.addEventListener('keydown', activate, { once: true })
    window.addEventListener('pointerdown', activate, { once: true })
    return () => {
      window.removeEventListener('keydown', activate)
      window.removeEventListener('pointerdown', activate)
      contextRef.current?.close().catch(() => undefined)
      contextRef.current = null
    }
  }, [])

  useEffect(() => {
    const context = contextRef.current
    if (!enabled || !ready || !context || context.state !== 'running') return

    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 440
    gain.gain.value = 0.05
    oscillator.connect(gain).connect(context.destination)
    oscillator.start()
    navigator.vibrate?.([180, 120, 180])
    return () => {
      navigator.vibrate?.(0)
      oscillator.stop()
      oscillator.disconnect()
      gain.disconnect()
    }
  }, [enabled, ready])
}

/**
 * Owns the fourth, deliberately independent user-SSE reader. Its replay input
 * is reconciled against the live call route before it can make sound; an event
 * stream proves delivery, never that a stale ring still deserves attention.
 */
export const IncomingCallProvider = ({ children }: PropsWithChildren) => {
  const apiClient = useApiClient()
  const { me, token } = useAuthSession()
  const { focusModeEnabled } = useFocusMode()
  const location = useLocation()
  const redirect = useRedirect()
  const currentUserId = me?.user.id ?? null
  const [state, dispatch] = useReducer(incomingCallReducer, undefined, initialReducer)
  const [now, setNow] = useState(Date.now())
  const [deepLinkedCall, setDeepLinkedCall] = useState<CallIncomingEvent | null>(null)
  const [presentedCall, setPresentedCall] = useState<PresentedCall | null>(null)
  const [dismissedCallIds, setDismissedCallIds] = useState<Set<string>>(() => new Set())
  const [pending, setPending] = useState(false)
  const [verifiedSoundCallId, setVerifiedSoundCallId] = useState<string | null>(null)

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    dispatch({ type: 'reset' })
    setDeepLinkedCall(null)
    setPresentedCall(null)
    setDismissedCallIds(new Set())
    setVerifiedSoundCallId(null)
  }, [currentUserId])

  const verifyLiveRing = useCallback(async (incoming: CallIncomingEvent): Promise<void> => {
    if (!currentUserId) return
    try {
      const call = await apiClient.get<CallRecord>(`/api/channels/${incoming.channelId}/call`)
      if (call && call.id === incoming.callId && isLiveInviteFor(call, currentUserId, Date.now())) {
        setVerifiedSoundCallId(incoming.callId)
      }
    } catch {
      // A future event or reconnect will repair an unavailable call lookup.
    }
  }, [apiClient, currentUserId])

  useEffect(() => {
    if (!token || !currentUserId) return undefined

    let cancelled = false
    let controller: AbortController | null = null
    let lastEventId = ''

    const attempt = async (): Promise<StreamAttemptOutcome> => {
      const reconnecting = lastEventId !== ''
      const request = new AbortController()
      controller = request
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${token}` }
        if (lastEventId) headers['Last-Event-ID'] = lastEventId
        const response = await fetch(`${getBaseUrl()}/api/events/stream`, {
          headers,
          signal: request.signal,
        })
        const outcome = classifyStreamResponse(response)
        if (outcome !== 'connected' || !response.body) return outcome

        await readSseStream(response.body, (frame) => {
          if (frame.id) lastEventId = frame.id
          const event = parseIncomingCallEvent(frame)
          if (!event || !frame.id) return
          dispatch({
            type: 'event',
            value: { currentUserId, event, eventId: frame.id, now: Date.now() },
          })
          if (event.event === 'call.incoming') {
            if (reconnecting) {
              void verifyLiveRing(event.data)
            } else if (Date.parse(event.data.expiresAt) > Date.now()) {
              setVerifiedSoundCallId(event.data.callId)
            }
          }
        })
        return 'connected'
      } finally {
        if (controller === request) controller = null
      }
    }

    void runStreamConnectionLoop({
      attempt,
      isCancelled: () => cancelled,
      sleep: (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
    })
    return () => {
      cancelled = true
      controller?.abort()
    }
  }, [currentUserId, token, verifyLiveRing])

  const incomingCalls = liveIncomingCalls(state, now)
  const currentIncomingCall = incomingCalls.find((call) => !dismissedCallIds.has(call.callId)) ?? null
  const displayedCall = presentedCall?.call ?? deepLinkedCall ?? currentIncomingCall
  const presentation: IncomingCallPresentation = presentedCall?.presentation ?? 'ringing'
  const quietHours = me?.user.preferences?.pushQuietHours
  const attentionMuted = focusModeEnabled
    || Boolean(quietHours && isWithinCallQuietHours(quietHours, new Date(now)))
  const ringtoneEnabled = Boolean(
    displayedCall
    && presentation === 'ringing'
    && verifiedSoundCallId === displayedCall.callId
    && !attentionMuted,
  )
  useRingtone(ringtoneEnabled)

  const closeDialog = () => {
    if (displayedCall) {
      setDismissedCallIds((current) => new Set([...current, displayedCall.callId]))
    }
    setDeepLinkedCall(null)
    setPresentedCall(null)
    setVerifiedSoundCallId(null)
  }

  const acceptCall = () => {
    if (!displayedCall || pending) return
    const target = displayedCall
    if (isDesktopApp() || isReactNativeWebView()) {
      void openExternalUrl(target.meetingUri)
    }
    setPending(true)
    void apiClient.post<CallAcceptResponse>(`/api/calls/${target.callId}/accept`, {}).then(
      (result) => setPresentedCall({ call: target, presentation: mapAcceptResponse(result.code) }),
      (error: unknown) => setPresentedCall({
        call: target,
        presentation: mapAcceptResponse(error instanceof ApiClientError ? error.code : undefined),
      }),
    ).finally(() => setPending(false))
  }

  const declineCall = () => {
    if (!displayedCall || pending) return
    const target = displayedCall
    setPending(true)
    void apiClient.post<CallRecord>(`/api/calls/${target.callId}/decline`, {}).then(
      () => closeDialog(),
      (error: unknown) => setPresentedCall({
        call: target,
        presentation: mapAcceptResponse(error instanceof ApiClientError ? error.code : undefined),
      }),
    ).finally(() => setPending(false))
  }

  const joinExternally = () => {
    if (displayedCall && (isDesktopApp() || isReactNativeWebView())) {
      void openExternalUrl(displayedCall.meetingUri)
    }
  }

  useEffect(() => {
    const parameters = new URLSearchParams(location.search)
    const incomingCallId = parameters.get('incomingCall')
    const acceptCallId = parameters.get('acceptCall')
    const requestedCallId = acceptCallId ?? incomingCallId
    const channelId = parseChannelIdFromPath(location.pathname)
    if (!requestedCallId || !channelId || !currentUserId) return

    let cancelled = false
    const consumeUrlIntent = async () => {
      try {
        const call = await apiClient.get<CallRecord | null>(`/api/channels/${channelId}/call`)
        if (cancelled || !call || call.id !== requestedCallId) return
        const incoming = asIncomingCall(call)
        if (!incoming) return
        if (acceptCallId) {
          try {
            const result = await apiClient.post<CallAcceptResponse>(`/api/calls/${call.id}/accept`, {})
            if (!cancelled) setPresentedCall({ call: incoming, presentation: mapAcceptResponse(result.code) })
          } catch (error) {
            if (!cancelled) setPresentedCall({
              call: incoming,
              presentation: mapAcceptResponse(error instanceof ApiClientError ? error.code : undefined),
            })
          }
        } else if (isLiveInviteFor(call, currentUserId, Date.now()) && !cancelled) {
          setDeepLinkedCall(incoming)
        }
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(location.search)
          next.delete('incomingCall')
          next.delete('acceptCall')
          redirect({ pathname: location.pathname, search: next.toString() ? `?${next}` : '' })
        }
      }
    }
    void consumeUrlIntent()
    return () => {
      cancelled = true
    }
  }, [apiClient, currentUserId, location.pathname, location.search, redirect])

  const realtimeValue = useMemo(() => ({
    inviteUpdates: state.inviteUpdates,
    updates: state.updates,
  }), [state.inviteUpdates, state.updates])

  return (
    <CallRealtimeContext.Provider value={realtimeValue}>
      {children}
      <IncomingCallDialog
        call={displayedCall}
        onAccept={acceptCall}
        onClose={closeDialog}
        onDecline={declineCall}
        onJoin={joinExternally}
        pending={pending}
        presentation={presentation}
      />
    </CallRealtimeContext.Provider>
  )
}
