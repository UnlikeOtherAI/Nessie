import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { VoiceDictationResponse } from '@nessie/schemas'

import { encodePcmFrame, startVoiceCapture, type VoiceCapture } from '../../../facades/voice/voice-audio'
import { useApiClient } from '../../../providers/ApiClientProvider'
import {
  appendBoundedVoiceFrame,
  VOICE_DICTATION_MAX_RECORDING_MS,
  VOICE_DICTATION_SAMPLE_RATE,
  type VoiceDictationState,
} from './voice-dictation-state'

let activeOwner: symbol | null = null

type Props = {
  disabled?: boolean
  onInsertTranscript: (text: string) => void
  onStateChange?: (state: VoiceDictationState) => void
}

/**
 * The one shared text-dictation control for every chat composer. Browser audio
 * stays on-device until Stop, then one bounded PCM payload travels through
 * Nessie to Ledger. A module lock keeps two mounted composers from recording
 * simultaneously and competing for a microphone.
 */
export const VoiceDictationControl = ({ disabled = false, onInsertTranscript, onStateChange }: Props) => {
  const apiClient = useApiClient()
  const owner = useRef(Symbol('voice-dictation'))
  const capture = useRef<VoiceCapture | null>(null)
  const frames = useRef<Int16Array[]>([])
  const capturedSamples = useRef(0)
  const timer = useRef<number | null>(null)
  const transcriptionAbort = useRef<AbortController | null>(null)
  const transcriptionGeneration = useRef(0)
  const stopped = useRef(false)
  const captureAttempt = useRef(0)
  const levelAt = useRef(0)
  const [state, setState] = useState<VoiceDictationState>('idle')
  const [level, setLevel] = useState(0)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const setVoiceState = useCallback((next: VoiceDictationState) => {
    setState(next)
    onStateChange?.(next)
  }, [onStateChange])

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])

  const releaseCapture = useCallback(async () => {
    clearTimer()
    const current = capture.current
    capture.current = null
    if (activeOwner === owner.current) activeOwner = null
    await current?.stop()
  }, [clearTimer])

  const cancel = useCallback(async () => {
    stopped.current = true
    captureAttempt.current += 1
    transcriptionGeneration.current += 1
    transcriptionAbort.current?.abort()
    transcriptionAbort.current = null
    frames.current = []
    capturedSamples.current = 0
    await releaseCapture()
    setElapsedSeconds(0)
    setLevel(0)
    setError(null)
    setVoiceState('idle')
  }, [releaseCapture, setVoiceState])

  const stopAndTranscribe = useCallback(async () => {
    if (stopped.current || !capture.current) return
    stopped.current = true
    await releaseCapture()
    const samples = capturedSamples.current
    if (samples === 0) {
      setError('No audio was captured. Check microphone permission and try again.')
      setVoiceState('error')
      return
    }
    const pcm = new Int16Array(samples)
    let offset = 0
    for (const frame of frames.current) {
      pcm.set(frame, offset)
      offset += frame.length
    }
    frames.current = []
    capturedSamples.current = 0
    setVoiceState('transcribing')
    const generation = transcriptionGeneration.current
    const controller = new AbortController()
    transcriptionAbort.current = controller
    try {
      const response = await apiClient.post<VoiceDictationResponse>('/api/voice/transcriptions', {
        audioBase64: encodePcmFrame(pcm),
        idempotencyKey: crypto.randomUUID(),
        locale: Intl.getCanonicalLocales(navigator.language)[0] ?? 'en-GB',
      }, undefined, { signal: controller.signal })
      if (transcriptionGeneration.current !== generation) return
      if (!response.transcript.trim()) {
        setError('No speech was recognized. Your draft is unchanged.')
        setVoiceState('error')
        return
      }
      onInsertTranscript(response.transcript)
      setElapsedSeconds(0)
      setLevel(0)
      setVoiceState('idle')
    } catch (caught) {
      if (transcriptionGeneration.current !== generation) return
      setError(caught instanceof Error ? caught.message : 'Voice transcription failed. Your draft is unchanged.')
      setVoiceState('error')
    } finally {
      if (transcriptionGeneration.current === generation) transcriptionAbort.current = null
    }
  }, [apiClient, onInsertTranscript, releaseCapture, setVoiceState])

  const start = useCallback(async () => {
    if (disabled || (state !== 'idle' && state !== 'error')) return
    if (activeOwner && activeOwner !== owner.current) {
      setError('Another voice recording is already active.')
      setVoiceState('error')
      return
    }
    activeOwner = owner.current
    stopped.current = false
    transcriptionGeneration.current += 1
    const attempt = captureAttempt.current + 1
    captureAttempt.current = attempt
    frames.current = []
    capturedSamples.current = 0
    setError(null)
    setElapsedSeconds(0)
    setVoiceState('requestingPermission')
    try {
      const openedCapture = await startVoiceCapture({
        onFrame: (frame) => {
          const bounded = appendBoundedVoiceFrame(frame, capturedSamples.current)
          if (!bounded.frame) {
            void stopAndTranscribe()
            return
          }
          const accepted = bounded.frame
          frames.current.push(accepted)
          capturedSamples.current = bounded.collectedSamples
          const magnitude = accepted.reduce((sum, sample) => sum + Math.abs(sample), 0) / accepted.length / 0x7fff
          const now = performance.now()
          if (now - levelAt.current > 80) {
            levelAt.current = now
            setLevel(Math.min(1, magnitude * 3))
            setElapsedSeconds(Math.floor(capturedSamples.current / VOICE_DICTATION_SAMPLE_RATE))
          }
          if (bounded.reachedCap) void stopAndTranscribe()
        },
      })
      if (stopped.current || captureAttempt.current !== attempt || activeOwner !== owner.current) {
        await openedCapture.stop()
        return
      }
      capture.current = openedCapture
      setVoiceState('recording')
      timer.current = window.setTimeout(() => { void stopAndTranscribe() }, VOICE_DICTATION_MAX_RECORDING_MS)
    } catch (caught) {
      if (captureAttempt.current !== attempt || activeOwner !== owner.current) return
      if (activeOwner === owner.current) activeOwner = null
      setError(caught instanceof Error ? caught.message : 'Microphone permission was not granted.')
      setVoiceState('error')
    }
  }, [disabled, setVoiceState, state, stopAndTranscribe])

  useEffect(() => () => {
    transcriptionGeneration.current += 1
    transcriptionAbort.current?.abort()
    transcriptionAbort.current = null
    void releaseCapture()
  }, [releaseCapture])

  useEffect(() => {
    if (state !== 'recording' && state !== 'requestingPermission') return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancel, state])

  if (state === 'recording' || state === 'requestingPermission' || state === 'transcribing') {
    return (
      <div aria-live="polite" className="voice-dictation-active">
        <button aria-label="Cancel voice recording" className="voice-dictation-button" onClick={() => void cancel()} type="button">×</button>
        <div aria-label={state === 'transcribing' ? 'Transcribing voice recording' : `Recording voice, ${elapsedSeconds} seconds`} className="voice-dictation-wave" role="status" style={{ '--voice-level': level } as CSSProperties}>
          {Array.from({ length: 26 }, (_, index) => <span aria-hidden="true" key={index} />)}
        </div>
        <button aria-label={state === 'transcribing' ? 'Transcribing voice recording' : 'Stop and transcribe voice recording'} className="voice-dictation-button" disabled={state === 'transcribing'} onClick={() => void stopAndTranscribe()} type="button">
          {state === 'transcribing' ? <span className="voice-dictation-spinner" /> : <span aria-hidden="true" className="voice-dictation-stop" />}
        </button>
      </div>
    )
  }

  return (
    <span className="voice-dictation-control">
      <button aria-label="Record voice message" className="voice-dictation-button" disabled={disabled} onClick={() => void start()} title="Record voice message" type="button">
        <svg aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect height="11" rx="5.5" width="7" x="8.5" y="2" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" strokeLinecap="round" /></svg>
      </button>
      {error ? <span className="voice-dictation-error" role="alert">{error}</span> : null}
    </span>
  )
}
